// 时间线复刻（真机同款）：用真实 SessionStore + 插件跑多轮，
// 把每一轮模型实际看到的消息（deriveMessages）逐条打印出来。
// 用来肉眼核对「上一轮的前后缀到底有没有留在下一轮」这类问题。
//
// 用法：node .agents/checks/verify-timeline.mjs
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

const home = await mkdtemp(join(tmpdir(), 'dsh-pi-timeline-'))
process.env.DSH_HOME = home

const { apply } = await import('../../lib/index.js')

const textOf = (message) =>
  (message?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')

const kindOf = (message) => `${message?.source?.kind ?? '?'}${message?.source?.turn === undefined ? '' : `#${message.source.turn}`}`

const routes = []
const listeners = new Map()
const projectionState = { pending: null, lastUsed: null }
const ctx = {
  connection: { fetch: { register: (route) => (routes.push(route), () => {}) } },
  llm: {
    listProviders: () => [{ id: 'deepseek-account', displayName: 'DeepSeek' }],
    listModels: async (provider) => [{ provider, id: 'deepseek-flash', name: 'deepseek-flash' }],
  },
  systemPrompt: { getSectionOrder: () => 0, section: () => () => {} },
  sessions: {},
  agents: { list: () => [] },
  agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
  get: (name) => {
    if (name === 'agents') return ctx.agents
    if (name === 'sessionProjections') return { stateOf: () => projectionState }
    if (name === 'agentDefaultModel') return ctx.agentDefaultModel
    return undefined
  },
  effect: (callback) => {
    const result = callback()
    return typeof result === 'function' ? result : () => {}
  },
  on: (name, listener) => {
    const list = listeners.get(name) ?? []
    list.push(listener)
    listeners.set(name, list)
    return () => {}
  },
  logger: () => ({ warn: () => {} }),
}

apply(ctx)

const root = new Context()
await root.plugin(SessionStore)
const session = root.sessions.create('timeline', { meta: { cwd: process.cwd() } })
const agent = { session, options: { provider: 'deepseek-account', model: 'deepseek-flash' } }
projectionState.pending = { provider: 'deepseek-account', model: 'deepseek-flash' }

const preStep = async (messages, turn, step) => {
  const chain = listeners.get('agent/pre-step') ?? []
  const base = async () => ({ kind: 'enter', messages })
  let next = base
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const listener = chain[index]
    const inner = next
    next = () => listener({ agent, messages, turn, step, signal: undefined }, inner)
  }
  return next()
}

const rulesRoute = routes.find((route) => route.path === '/api/dsh-prompt-inject/rules')
const stateRoute = routes.find((route) => route.path === '/api/dsh-prompt-inject/state')
const state = await (await stateRoute.fetch(new Request('http://localhost/state'))).json()
await rulesRoute.fetch(
  new Request('http://localhost/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      revision: state.revision,
      slots: {
        ...state.slots,
        'user.prefix': { rules: [{ id: 'p', enabled: true, text: '【前置】', models: { all: true, list: [] } }] },
        'user.suffix': { rules: [{ id: 's', enabled: true, text: '【后置】', models: { all: true, list: [] } }] },
      },
    }),
  }),
)

/** 打印当前 surface 派生消息。 */
const dump = (label) => {
  const messages = session.deriveMessages()
  console.log(`\n=== ${label}（模型看到 ${messages.length} 条）`)
  messages.forEach((message, index) => {
    console.log(`  [${index}] ${kindOf(message)} :: ${textOf(message).replace(/\n/g, '\\n').slice(0, 60)}`)
  })
  return messages
}

/** 走一轮：pre-step + 落库 + 助手回复 + 工具结果。 */
const round = async (turn, text) => {
  const claimed = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId: `rpc-${turn}` } })
  const decision = await preStep([claimed], turn, 1)
  console.log(`\n--- 第 ${turn} 轮：pre-step 决定 ${decision.messages.length} 条 -> ${decision.messages.map(textOf).join(' | ')}`)
  for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' })
  dump(`第 ${turn} 轮 step 1`)
  const call = createAssistantMessage({
    content: [{ type: 'tool-call', id: `call-${turn}`, name: 'read', arguments: '{}' }],
    source: { provider: 'deepseek-account', model: 'deepseek-flash' },
  })
  session.append('assistant/message', { turn, step: 1, message: call }, { surfaceOp: 'append' })
  session.append('tool/result', { turn, step: 1, message: createUserMessage({ content: [{ type: 'text', text: 'tool out' }], source: { kind: 'tool' } }) }, { surfaceOp: 'append' })
  const loop = await preStep([], turn, 2)
  console.log(`--- 第 ${turn} 轮 step 2（工具循环）：pre-step 决定 ${loop.messages.length} 条`)
  for (const message of loop.messages) session.append('user/message', message, { surfaceOp: 'append' })
  dump(`第 ${turn} 轮 step 2`)
  const answer = createAssistantMessage({ content: [{ type: 'text', text: `助手回复${turn}` }], source: { provider: 'deepseek-account', model: 'deepseek-flash' } })
  session.append('assistant/message', { turn, step: 2, message: answer }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

await round(1, '用户输入一')
await round(2, '用户输入二')
await round(3, '用户输入三')

console.log('\n=== 会话真源（只看 append 的 user/message）')
for (const event of session.snapshotEvents().filter((item) => item.type === 'user/message' && isAppendSurfaceEvent(item))) {
  console.log(`  seq ${event.seq} [${event.data.source.kind}${event.data.source.turn === undefined ? '' : `#${event.data.source.turn}`}] ${textOf(event.data).slice(0, 40)}`)
}

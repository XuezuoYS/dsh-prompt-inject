// 回归：**注入永久保留**（用户拍板的当前行为）。
//
// 历史：最初的行为是下一轮把上一轮的「前缀 / 原文 / 后缀」整段还原掉，怕后置词被当成
// 「用户又补充的一句」。后来用户明确要求改成「不还原、永久保留」——还原动作会改写 surface，
// 干扰轨迹视图，而注入本来就该作为一个上下文块留在历史里。
//
// 这个脚本用真实 SessionStore 跑多轮，断言当前行为：
// 1. 每轮照旧注入一次（前缀 / 原文 / 后缀三条）；
// 2. 历史轮次的注入**不消失**，一轮轮累积（数量 = 轮次）；
// 3. 不再产生任何被抹掉的空占位；
// 4. 工具循环里不会重复注入。
//
// 用法：node .agents/checks/verify-inject-persistence.mjs
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

const home = await mkdtemp(join(tmpdir(), 'dsh-pi-leak-'))
process.env.DSH_HOME = home

const { apply } = await import('../../lib/index.js')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
const textOf = (message) =>
  (message?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')

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
const session = root.sessions.create('no-leak', { meta: { cwd: process.cwd() } })
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
        'user.prefix': { rules: [{ id: 'p', enabled: true, text: 'PREFIX', models: { all: true, list: [] } }] },
        'user.suffix': { rules: [{ id: 's', enabled: true, text: 'SUFFIX', models: { all: true, list: [] } }] },
      },
    }),
  }),
)

/** 跑一轮并返回该轮 step 1 / step 2 时模型看到的消息。 */
const runRound = async (turn) => {
  const claimed = createUserMessage({ content: [{ type: 'text', text: `USER-${turn}` }], source: { kind: 'user', rpcId: `rpc-${turn}` } })
  const decision = await preStep([claimed], turn, 1)
  for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' })
  const stepOneMessages = session.deriveMessages()
  const stepOne = stepOneMessages.map(textOf)
  // 工具循环
  const call = createAssistantMessage({
    content: [{ type: 'tool-call', id: `call-${turn}`, name: 'read', arguments: '{}' }],
    source: { provider: 'deepseek-account', model: 'deepseek-flash' },
  })
  session.append('assistant/message', { turn, step: 1, message: call }, { surfaceOp: 'append' })
  session.append('tool/result', { turn, step: 1, message: createUserMessage({ content: [{ type: 'text', text: `OUT-${turn}` }], source: { kind: 'tool' } }) }, { surfaceOp: 'append' })
  const loop = await preStep([], turn, 2)
  for (const message of loop.messages) session.append('user/message', message, { surfaceOp: 'append' })
  const stepTwoMessages = session.deriveMessages()
  const stepTwo = stepTwoMessages.map(textOf)
  const answer = createAssistantMessage({ content: [{ type: 'text', text: `ANSWER-${turn}` }], source: { provider: 'deepseek-account', model: 'deepseek-flash' } })
  session.append('assistant/message', { turn, step: 2, message: answer }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return { stepOne, stepTwo, stepOneMessages, stepTwoMessages }
}

const rounds = []
for (const turn of [1, 2, 3, 4]) rounds.push(await runRound(turn))

// 每轮照旧注入一次；历史轮次的注入不消失，累积成 轮次 条。
rounds.forEach((round, index) => {
  const turn = index + 1
  const prefixCount = round.stepOne.filter((text) => text === 'PREFIX').length
  const suffixCount = round.stepOne.filter((text) => text === 'SUFFIX').length
  check(
    `第 ${turn} 轮：注入累积到 ${turn} 条（历史轮次的前后缀没有被清除）`,
    prefixCount === turn && suffixCount === turn,
    `PREFIX×${prefixCount} SUFFIX×${suffixCount}`,
  )
})

// 每一轮的注入都紧跟在「它自己那轮的原文」之后，顺序不乱。
const lastRound = rounds[rounds.length - 1]
check(
  '最后一轮：每轮都是「PREFIX → 该轮原文 → SUFFIX」的相邻三元组',
  [1, 2, 3, 4].every((turn) => {
    const at = lastRound.stepOne.indexOf(`USER-${turn}`)
    return at > 0 && lastRound.stepOne[at - 1] === 'PREFIX' && lastRound.stepOne[at + 1] === 'SUFFIX'
  }),
  JSON.stringify(lastRound.stepOne),
)
check(
  '最后一轮：四轮的用户原文都还在',
  ['USER-1', 'USER-2', 'USER-3', 'USER-4'].every((text) => lastRound.stepOne.includes(text)),
  JSON.stringify(lastRound.stepOne),
)
check(
  '最后一轮：历史里没有空的 user 消息（不再产生被抹掉的空占位）',
  lastRound.stepOneMessages.filter((message) => message.role === 'user' && textOf(message) === '').length === 0,
  JSON.stringify(lastRound.stepOne),
)

// 工具循环里不能重复注入。
check(
  '工具循环：注入数量与 step 1 一致，不会重复注入',
  lastRound.stepTwo.filter((text) => text === 'PREFIX').length === 4 && lastRound.stepTwo.filter((text) => text === 'SUFFIX').length === 4,
  JSON.stringify(lastRound.stepTwo),
)

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)

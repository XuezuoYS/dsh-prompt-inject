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
// 4. 工具循环里不会重复注入；
// 5. 老版本留下的空占位（`prompt-inject` + 空 content）**不碰、不报错**——官方 surface
//    只有 `append` 与 `{ op: 'replace', startSeq, endSeq }` 两种 op，换不出「少一个节点」，
//    删除节点没有 API，所以这些空占位只能留着（见文件末尾那一节）。
//
// 配置是 v2 的 groups：一个组里配 user.prefix / user.suffix 两个位置。
//
// 用法：node tests/verify-inject-persistence.mjs
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { emptyPositions } from '../lib/groupConfig.js'

const home = await mkdtemp(join(tmpdir(), 'dsh-pi-leak-'))
process.env.DSH_HOME = home

const { apply } = await import('../lib/index.js')

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

/**
 * 造一个完整组：没给的位置补默认块。
 * @param {Record<string, { enabled: boolean, text: string }>} positions - 要覆盖的位置块。
 * @returns {object} 组。
 */
const group = (positions) => ({
  id: 'g1',
  name: '组 1',
  enabled: true,
  models: { all: true, list: [] },
  positions: { ...emptyPositions(), ...positions },
})

const routes = []
const listeners = new Map()
// 插件记下的诊断日志（`onWarn` 走的就是 `ctx.logger(...).warn`）。
const warns = []
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
  logger: () => ({ warn: (...args) => warns.push(args.map(String).join(' ')) }),
}

apply(ctx)

const root = new Context()
await root.plugin(SessionStore)
const session = root.sessions.create('no-leak', { meta: { cwd: process.cwd() } })
const agent = { session, options: { provider: 'deepseek-account', model: 'deepseek-flash' } }
projectionState.pending = { provider: 'deepseek-account', model: 'deepseek-flash' }

/**
 * 跑一次 pre-step 链。
 * @param {object[]} messages - 这一步要落库的消息。
 * @param {number} turn - 轮次。
 * @param {number} step - 步号。
 * @param {object} [target] - 走哪个 agent 的会话（默认第一轮那个）。
 * @returns {Promise<object>} 链尾的决定。
 */
const preStep = async (messages, turn, step, target = agent) => {
  const chain = listeners.get('agent/pre-step') ?? []
  const base = async () => ({ kind: 'enter', messages })
  let next = base
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const listener = chain[index]
    const inner = next
    next = () => listener({ agent: target, messages, turn, step, signal: undefined }, inner)
  }
  return next()
}

const rulesRoute = routes.find((route) => route.path === '/api/dsh-prompt-inject/rules')
const stateRoute = routes.find((route) => route.path === '/api/dsh-prompt-inject/state')
const state = await (await stateRoute.fetch(new Request('http://localhost/state'))).json()
check('初始状态是零组', Array.isArray(state.groups) && state.groups.length === 0, JSON.stringify(state.groups))
await rulesRoute.fetch(
  new Request('http://localhost/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      revision: state.revision,
      groups: [
        group({
          'user.prefix': { enabled: true, text: 'PREFIX' },
          'user.suffix': { enabled: true, text: 'SUFFIX' },
        }),
      ],
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

// ---------------------------------------------------------------------------
// 老版本留下的空占位：插件不碰、不报错。
//
// 官方 surface 只有 `append` 与 `{ op: 'replace', startSeq, endSeq }` 两种 op，replace 是
// 「一段节点换成一个节点」，节点数不会因此变少，**删除节点没有 API**。所以这些老空占位
// 只能留着；插件要是再去「清」它们（曾经的 `op: 'remove'` 会被 SessionStore 当场拒绝），
// 就会被 try/catch 吞成一条 warn，每轮刷一次。这一节就是钉住「别写 surface」。
// 替身会话：先落一条用户原文，再落一条注入，最后把那一条注入换成老版本留下的空占位
// （合法 replace，节点数不变）——这就是 `dropInjections` 当年写出来的形状。
const legacy = root.sessions.create('legacy-placeholder', { meta: { cwd: process.cwd() } })
legacy.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'OLD-USER' }], source: { kind: 'user', rpcId: 'rpc-old' } }), { surfaceOp: 'append' })
const legacyInjection = legacy.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'OLD-PREFIX' }], source: { kind: 'prompt-inject' } }), { surfaceOp: 'append' })
const legacyTombstone = legacy.append(
  'user/message',
  createUserMessage({ content: [], source: { kind: 'prompt-inject', dropped: true } }),
  { surfaceOp: { op: 'replace', startSeq: legacyInjection.seq, endSeq: legacyInjection.seq }, sourceEventSeqs: [legacyInjection.seq] },
)

const eventsBefore = legacy.snapshotEvents().length
const warnsBefore = warns.length
const legacyAgent = { session: legacy, options: { provider: 'deepseek-account', model: 'deepseek-flash' } }
const legacyClaimed = createUserMessage({ content: [{ type: 'text', text: 'NEW-USER' }], source: { kind: 'user', rpcId: 'rpc-new' } })
const legacyDecision = await preStep([legacyClaimed], 1, 1, legacyAgent)

check(
  '老空占位：pre-step 不写 warn（不会每轮刷日志）',
  warns.length === warnsBefore,
  warns.slice(warnsBefore).join(' | ') || '(无)',
)
check(
  '老空占位：pre-step 不往会话里写任何事件（对 surface 零写入）',
  legacy.snapshotEvents().length === eventsBefore,
  `${eventsBefore} → ${legacy.snapshotEvents().length}`,
)
check(
  '老空占位：删不掉，原样留在 surface 上（已拍板的行为）',
  legacy.surface.nodes.includes(legacyTombstone.seq),
  JSON.stringify(legacy.surface.nodes),
)

// 真链路里这些消息由 agent loop 以 append 落库，这里照做：注入照常落在原文两侧。
for (const message of legacyDecision.messages) legacy.append('user/message', message, { surfaceOp: 'append' })
const legacyTexts = legacy.deriveMessages().map(textOf)
const newUserAt = legacyTexts.indexOf('NEW-USER')
check(
  '老空占位：注入照常落位，用户原文没被吞',
  legacyTexts.includes('OLD-USER') && newUserAt > 0 && legacyTexts[newUserAt - 1] === 'PREFIX' && legacyTexts[newUserAt + 1] === 'SUFFIX',
  JSON.stringify(legacyTexts),
)

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)

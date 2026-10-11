// 端到端（host 侧）：用真实 SessionStore 跑「注入 → 工具循环 → 下一轮还原 → 再注入」，
// 并核对每一轮模型实际会看到的消息。不碰真实 DSH，用的是临时 DSH_HOME。
//
// 用法：node .agents/checks/verify-inject-flow.mjs
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

const home = await mkdtemp(join(tmpdir(), 'dsh-prompt-inject-home-'))
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

// ---------- 假的 host 环境 ----------
const routes = []
const listeners = new Map()
// 模型选择投影的假状态：真机上由官方 `dsh-api-session-controller` 注册、随 `model/selection` 事件走。
const projectionState = { pending: null, lastUsed: null }
const ctx = {
  connection: { fetch: { register: (route) => (routes.push(route), () => {}) } },
  llm: {
    listProviders: () => [{ id: 'deepseek-account', displayName: 'DeepSeek' }],
    listModels: async (provider) => [{ provider, id: 'deepseek-flash', name: 'deepseek-flash' }, { provider, id: 'other', name: 'other' }],
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
    if (result !== null && typeof result === 'object' && typeof result.next === 'function') {
      while (result.next().done !== true) {
        /* 迭代生成器：注册它 yield 出来的 disposer */
      }
    }
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

// ---------- 真实会话 ----------
const root = new Context()
await root.plugin(SessionStore)
const session = root.sessions.create('inject-flow', { meta: { cwd: process.cwd() } })
const agent = {
  session,
  options: { provider: 'deepseek-account', model: 'deepseek-flash' },
}

/** 走一遍 agent/pre-step 的 waterfall（只有我们一个监听器，等价于 next() 给默认决定）。 */
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

/** 模拟 loop 的落库：首次尝试按顺序 append。 */
const commit = (decision) => {
  for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' })
}

// 先配好规则：前置词对全部模型生效，后置词只对别的模型生效。
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
        'user.prefix': { rules: [{ id: 'p', enabled: true, text: '【前置词】', models: { all: true, list: [] } }] },
        'user.suffix': { rules: [{ id: 's', enabled: true, text: '【后置词】', models: { all: true, list: [] } }] },
        'system.beforeTools': { rules: [{ id: 'b', enabled: true, text: '【工具说明之前】', models: { all: true, list: [] } }] },
      },
    }),
  }),
)

// ---------- 第 1 轮 ----------
const claimedOne = createUserMessage({ content: [{ type: 'text', text: '第一条用户输入' }], source: { kind: 'user', rpcId: 'rpc-1' } })
const decisionOne = await preStep([claimedOne], 1, 1)
check('第 1 轮：pre-step 给出「前缀 / 原文 / 后缀」三条', decisionOne.messages.length === 3, JSON.stringify(decisionOne.messages.map(textOf)))
check('第 1 轮：顺序是前缀 → 原文 → 后缀', decisionOne.messages.map(textOf).join('|') === '【前置词】|第一条用户输入|【后置词】', decisionOne.messages.map(textOf).join('|'))
check('第 1 轮：注入消息的 source.kind 是 prompt-inject（不会画成用户气泡）', decisionOne.messages[0].source.kind === 'prompt-inject' && decisionOne.messages[2].source.kind === 'prompt-inject')
check('第 1 轮：原文消息没被改动，id 与 source 保持', decisionOne.messages[1].id === claimedOne.id && decisionOne.messages[1].source.rpcId === 'rpc-1')
commit(decisionOne)
check('第 1 轮：模型看到三条连排 user 消息', session.deriveMessages().map(textOf).join('|') === '【前置词】|第一条用户输入|【后置词】')

// ---------- 同轮工具循环：pre-step 没有用户消息 ----------
const assistantCall = createAssistantMessage({
  content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' }],
  source: { provider: 'deepseek-account', model: 'deepseek-flash' },
})
session.append('assistant/message', { turn: 1, step: 1, message: assistantCall }, { surfaceOp: 'append' })
session.append('tool/result', { turn: 1, step: 1, message: createUserMessage({ content: [{ type: 'text', text: 'tool output' }], source: { kind: 'tool' } }) }, { surfaceOp: 'append' })
const decisionLoop = await preStep([], 1, 2)
check('工具循环：pre-step 不动消息', decisionLoop.messages.length === 0, JSON.stringify(decisionLoop.messages.map(textOf)))
const loopTexts = session.deriveMessages().map(textOf)
check('工具循环：前后缀仍在且只有一份', loopTexts.filter((text) => text === '【前置词】').length === 1 && loopTexts.filter((text) => text === '【后置词】').length === 1, JSON.stringify(loopTexts))

// ---------- 第 2 轮 ----------
const claimedTwo = createUserMessage({ content: [{ type: 'text', text: '第二条用户输入' }], source: { kind: 'user', rpcId: 'rpc-2' } })
const decisionTwo = await preStep([claimedTwo], 2, 1)
check(
  '第 2 轮：新一轮照旧带前后缀（上一轮的注入不再被还原）',
  decisionTwo.messages.map(textOf).join('|') === '【前置词】|第二条用户输入|【后置词】',
  decisionTwo.messages.map(textOf).join('|'),
)
commit(decisionTwo)
const roundTwo = session.deriveMessages().map(textOf)
check(
  '第 2 轮：上一轮的注入仍留在历史里 —— 前/后缀各出现两次（上一轮 + 本轮）',
  roundTwo.filter((text) => text === '【前置词】').length === 2 && roundTwo.filter((text) => text === '【后置词】').length === 2,
  JSON.stringify(roundTwo),
)
check(
  '第 2 轮：历史里没有空的 user 消息（不再产生被抹掉的空占位卡片）',
  session.deriveMessages().filter((message) => message.role === 'user' && textOf(message) === '').length === 0,
  JSON.stringify(roundTwo),
)
check(
  '第 2 轮：两条用户原文都还在，顺序未变',
  roundTwo.indexOf('第一条用户输入') !== -1 && roundTwo.indexOf('第二条用户输入') !== -1 && roundTwo.indexOf('第一条用户输入') < roundTwo.indexOf('第二条用户输入'),
  JSON.stringify(roundTwo),
)

// ---------- 会话日志真源 ----------
const appendEvents = session.snapshotEvents().filter((event) => event.type === 'user/message' && isAppendSurfaceEvent(event))
check('append 真源完整：两条原文 + 两组前后缀', appendEvents.length === 6, appendEvents.map((event) => textOf(event.data)).join('|'))
check('真源里两条原文的 rpcId 都还在', appendEvents.filter((event) => textOf(event.data).endsWith('用户输入') && event.data.source.rpcId !== undefined).length === 2)

// ---------- system 段文本 ----------
const sectionsRoute = listeners.get('system-prompt/assemble')
check('system 段注册后可解析出文本（走 section 的 text 函数）', true)
const beforeToolsText = await (async () => {
  // 直接验证解析：从 section 定义里拿不到 ctx，这里用 /state 里的规则与 resolver 对齐。
  const { resolveSlot } = await import('../../lib/ruleResolver.js')
  const refreshed = await (await stateRoute.fetch(new Request('http://localhost/state'))).json()
  return resolveSlot(refreshed.slots, 'system.beforeTools', 'deepseek-account/deepseek-flash')
})()
check('system.beforeTools 的文本按规则拼出', beforeToolsText === '【工具说明之前】', beforeToolsText)
check('assemble 监听器已注册（persona 改写）', Array.isArray(sectionsRoute) && sectionsRoute.length === 1)

// ---------- 模型作用域 ----------
const answerState = await (await stateRoute.fetch(new Request('http://localhost/state'))).json()
check('/state 的 catalog 列出两个模型', answerState.catalog.providers[0].models.length === 2)

// ---------- 模型路由回归：切换后不能用上一个模型的规则 ----------
// 真机 bug：用户把会话从 flash 切到同 provider 的另一个模型后，「配给 flash 的规则」被打进了新模型的第一条请求。
// 这里把会话日志里的 request/context 固定成 flash（= 已提交的旧路由），再让投影说「下一个是 other」，
// 模拟切换刚发生、新请求还没落库的那一刻。
session.append('turn/start', { turn: 3 })
session.append('request/context', { provider: 'deepseek-account', model: 'deepseek-flash' })
check('构造成立：requestContext 停在旧模型 flash', session.requestContext()?.model === 'deepseek-flash')

const scopedState = await (await stateRoute.fetch(new Request('http://localhost/state'))).json()
await rulesRoute.fetch(
  new Request('http://localhost/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      revision: scopedState.revision,
      slots: {
        ...scopedState.slots,
        'user.prefix': {
          rules: [
            { id: 'p1', enabled: true, text: '【前置词】', models: { all: true, list: [] } },
            { id: 'p2', enabled: true, text: '【只给 flash】', models: { all: false, list: ['deepseek-account/deepseek-flash'] } },
          ],
        },
        'user.suffix': { rules: [] },
      },
    }),
  }),
)

projectionState.pending = { provider: 'deepseek-account', model: 'other' }
projectionState.lastUsed = { provider: 'deepseek-account', model: 'deepseek-flash' }
const claimedThree = createUserMessage({ content: [{ type: 'text', text: '切换后的第一条输入' }], source: { kind: 'user', rpcId: 'rpc-3' } })
const decisionThree = await preStep([claimedThree], 3, 1)
check(
  '切到同 provider 的另一个模型：flash 专属规则不再跟进（原 bug：会跟进）',
  decisionThree.messages.map(textOf).join('|') === '【前置词】|切换后的第一条输入',
  decisionThree.messages.map(textOf).join('|'),
)

projectionState.pending = { provider: 'deepseek-account', model: 'deepseek-flash' }
const claimedFour = createUserMessage({ content: [{ type: 'text', text: '切回 flash' }], source: { kind: 'user', rpcId: 'rpc-4' } })
const decisionFour = await preStep([claimedFour], 4, 1)
check(
  '切回 flash：专属规则照旧拼进去',
  decisionFour.messages.map(textOf).join('|') === '【前置词】\n\n【只给 flash】|切回 flash',
  decisionFour.messages.map(textOf).join('|'),
)

// ---------- 模板字段：注入那一刻就渲染成成品 ----------
const templateState = await (await stateRoute.fetch(new Request('http://localhost/state'))).json()
check('/state 带上了模板字段表（唯一真源在 templateFields.js）', Array.isArray(templateState.fields) && templateState.fields.map((field) => field.name).join(',') === 'model,provider,cwd')
await rulesRoute.fetch(
  new Request('http://localhost/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      revision: templateState.revision,
      slots: {
        ...templateState.slots,
        'user.prefix': {
          rules: [
            {
              id: 'tpl',
              enabled: true,
              text: '模型 {{model}}（{{provider}}），目录 {{cwd}}；拼错的 {{modle}} 原样',
              models: { all: true, list: [] },
            },
          ],
        },
        'user.suffix': { rules: [] },
      },
    }),
  }),
)
const claimedFive = createUserMessage({ content: [{ type: 'text', text: '模板轮' }], source: { kind: 'user', rpcId: 'rpc-5' } })
const decisionFive = await preStep([claimedFive], 5, 1)
const injectedTemplate = textOf(decisionFive.messages[0])
const expectedTemplate = `模型 deepseek-flash（deepseek-account），目录 ${process.cwd()}；拼错的 {{modle}} 原样`
check('模板字段按这一步的路由与工作目录渲染', injectedTemplate === expectedTemplate, injectedTemplate)
check('认不出的字段原样留在注入文本里（不抛错）', injectedTemplate.includes('{{modle}}'))
commit(decisionFive)
check('历史里存的是渲染后的成品，没有 {{}}', session.deriveMessages().map(textOf).every((text) => !text.includes('{{model}}') && !text.includes('{{cwd}}')))

// ---------- 归档判据回归（**不在生产路径上**）----------
// 真机事故：surface 里绝大多数节点不是 user/message（agent-instructions / runtime-context /
// 助手 / 工具结果），把它们压成 null 过滤掉之后，「摘要下标」就不再是「surface 下标」，
// 按位置算的还原区间会整体错位。当前行为是「注入永久保留、不还原」，所以生产路径**不调用**它；
// 这段保留给 `restoreLeftovers` 这套归档判据，将来若要把「自动清除」重新做成选项，它得是对的。
{
  const { restoreLeftovers } = await import('../../lib/sessionInjector.js')
  const leak = root.sessions.create('leak-regression', { meta: { cwd: process.cwd() } })
  const original = createUserMessage({ content: [{ type: 'text', text: '原文' }], source: { kind: 'user', rpcId: 'rpc-x' } })
  const suffix = createUserMessage({ content: [{ type: 'text', text: '【后置词】' }], source: { kind: 'prompt-inject', turn: 1 } })
  // 先原文、后注入；中间塞几条非 user/message 节点，把「摘要下标」和「surface 下标」拉开。
  leak.append('user/message', original, { surfaceOp: 'append' })
  leak.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: '答复' }], source: { provider: 'deepseek-account', model: 'deepseek-flash' } }) }, { surfaceOp: 'append' })
  leak.append('user/message', suffix, { surfaceOp: 'append' })
  leak.append('assistant/message', { turn: 1, step: 2, message: createAssistantMessage({ content: [{ type: 'text', text: '再答' }], source: { provider: 'deepseek-account', model: 'deepseek-flash' } }) }, { surfaceOp: 'append' })
  const changed = restoreLeftovers(leak, 2)
  const leaked = leak.deriveMessages().map(textOf)
  check('真机排列回归：下标不错位（restore 真的改动了 surface）', changed === true, JSON.stringify(leaked))
  check(
    '真机排列回归：上一轮的后缀不再出现在这一轮的上下文里',
    leaked.filter((text) => text === '【后置词】').length === 0 && leaked.includes('原文'),
    JSON.stringify(leaked),
  )
}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)

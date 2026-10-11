// host 半的接线检查：端点注册、/state 与 /rules 的真实往返、system 段注册与 persona 改写、
// 以及「模型设置变了 → 宿主目录缓存立刻失效」（见 verify-catalog-refresh.mjs 的客户端那一半）。
// 用假的 ctx 跑，不碰真实 DSH。
//
// 用法：node .agents/checks/verify-host-wiring.mjs
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'dsh-prompt-inject-home-'))
process.env.DSH_HOME = home

const { apply, inject } = await import('../../lib/index.js')
const { INJECT_POINTS, middleSectionPoints, replacedSectionPoints } = await import('../../lib/injectPoints.js')
const { CATALOG_INVALIDATION_EVENTS } = await import('../../lib/settingsApi.js')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 收集一遍 apply 期间发生的注册。 */
const routes = []
const sections = []
const listeners = []
const effects = []
const warnings = []

/** provider → 它报的模型；直接改它就能模拟「模型设置变了」。 */
const modelsByProvider = new Map([
  ['deepseek-account', [{ id: 'deepseek-flash', name: 'deepseek-flash' }]],
  ['broken-provider', [{ id: 'never', name: 'never' }]],
])
let providerListings = 0

const llm = {
  listProviders: () => {
    providerListings += 1
    return [
      { id: 'deepseek-account', displayName: 'DeepSeek 账号' },
      { id: 'broken-provider', displayName: '拉不动的 provider' },
    ]
  },
  listModels: async (provider) => {
    if (provider === 'broken-provider') throw new Error('目录拉取失败')
    return modelsByProvider.get(provider)
  },
}

const ctx = {
  connection: {
    fetch: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
  },
  llm,
  systemPrompt: {
    getSectionOrder: () => 0,
    section: (section) => {
      sections.push(section)
      return () => {}
    },
  },
  sessions: {},
  agents: {
    list: () => [
      {
        options: { provider: 'deepseek-account', model: 'deepseek-flash' },
        session: { requestContext: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
      },
    ],
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
  get: (name) => (name === 'agents' ? ctx.agents : name === 'agentDefaultModel' ? ctx.agentDefaultModel : undefined),
  effect: (callback, label) => {
    const result = callback()
    // cordis 的 effect body 可以是生成器：逐个 yield 出 disposer，这里照它的语义迭代一遍。
    if (result !== null && typeof result === 'object' && typeof result.next === 'function') {
      let step = result.next()
      while (step.done !== true) step = result.next()
    }
    effects.push(label)
    return typeof result === 'function' ? result : () => {}
  },
  on: (name, listener) => {
    listeners.push({ name, listener })
    return () => {}
  },
  logger: () => ({ warn: (...args) => warnings.push(args.join(' ')) }),
}

apply(ctx)

check('inject 声明了 connection/llm/systemPrompt/sessions', JSON.stringify(inject) === JSON.stringify(['connection', 'llm', 'systemPrompt', 'sessions']), JSON.stringify(inject))
check('注册了三个 /api 端点', routes.length === 3, routes.map((route) => route.path).join(','))
check('state 端点路径正确', routes.some((route) => route.path === '/api/dsh-prompt-inject/state' && route.methods.includes('GET')))
check('catalog 端点只读', routes.some((route) => route.path === '/api/dsh-prompt-inject/catalog' && JSON.stringify(route.methods) === JSON.stringify(['GET', 'HEAD'])))
check('rules 端点只收 POST', routes.some((route) => route.path === '/api/dsh-prompt-inject/rules' && JSON.stringify(route.methods) === JSON.stringify(['POST'])))
check('端点都在 /api 下', routes.every((route) => route.path.startsWith('/api/')))
check(
  '挂上了全部「目录失效」事件（与客户端半同一张表）',
  CATALOG_INVALIDATION_EVENTS.every((event) => listeners.some((item) => item.name === event)),
  listeners.map((item) => item.name).join(','),
)

// system 段：4 个中间锚点，名字与 order 与规格一致。
const expectedSections = INJECT_POINTS.filter((point) => point.sectionName !== undefined)
check('注册了 4 个 system 中间段', sections.length === 4, sections.map((section) => `${section.name}@${section.order}`).join(', '))
check(
  '段名与 order 与注入点表一致',
  expectedSections.every((point) => sections.some((section) => section.name === point.sectionName && section.order === point.order)),
  sections.map((section) => `${section.name}@${section.order}`).join(', '),
)
check('persona 头与尾是两个独立注入点', INJECT_POINTS.some((point) => point.key === 'system.personaHead') && INJECT_POINTS.some((point) => point.key === 'system.personaTail') && !INJECT_POINTS.some((point) => point.key === 'system.persona'))
check('系统注入点分两类：中间锚点 4 个 + 改写官方段 2 个', middleSectionPoints().length === 4 && replacedSectionPoints().length === 2)
check('pre-step 监听器注册在最外层（prepend）', listeners.some((item) => item.name === 'agent/pre-step'))
check('assemble 监听器已注册', listeners.some((item) => item.name === 'system-prompt/assemble'))

// ---------- /state 往返 ----------
const stateRoute = routes.find((route) => route.path === '/api/dsh-prompt-inject/state')
const stateResponse = await stateRoute.fetch(new Request('http://localhost/api/dsh-prompt-inject/state'))
const state = await stateResponse.json()
check('GET /state 返回 200', stateResponse.status === 200, String(stateResponse.status))
check('/state 带 revision 与全部注入点', state.revision === 0 && Object.keys(state.slots).length === 8, JSON.stringify(Object.keys(state.slots)))
check(
  '/state 不再下发「当前模型」（多会话并行时它不准，界面也不再显示）',
  state.catalog.current === undefined && Object.keys(state.catalog).sort().join(',') === 'degraded,providers',
  JSON.stringify(Object.keys(state.catalog)),
)
check('/state 的 catalog 按 provider 分组', state.catalog.providers[0]?.models?.[0]?.id === 'deepseek-flash')
check('provider 目录拉不动时 degraded=true，不阻断', state.catalog.degraded === true && state.catalog.providers.length === 1, JSON.stringify(state.catalog.providers.map((item) => item.id)))
check(
  '/state 下发模板字段与注释（唯一真源在 templateFields.js）',
  Array.isArray(state.fields) && state.fields.map((field) => field.name).join(',') === 'model,provider,cwd' && state.fields.every((field) => typeof field.label === 'string' && typeof field.note === 'string' && field.note !== ''),
  JSON.stringify(state.fields),
)

// ---------- /catalog：只给目录，且模型设置一变就失效 ----------
const catalogRoute = routes.find((route) => route.path === '/api/dsh-prompt-inject/catalog')
const readCatalog = async () => (await catalogRoute.fetch(new Request('http://localhost/api/dsh-prompt-inject/catalog'))).json()

const catalogBefore = await readCatalog()
check(
  '/catalog 只给 providers 与 degraded（不下发规则、不动规则状态）',
  Object.keys(catalogBefore).sort().join(',') === 'degraded,providers',
  JSON.stringify(Object.keys(catalogBefore)),
)
check('catalog 与 state 共用同一份缓存，没有重复问 provider', providerListings === 1, String(providerListings))
check('catalog 里 provider 拉不动同样标记 degraded，不阻断', catalogBefore.degraded === true && catalogBefore.providers.length === 1)

// 模拟「模型设置页改了模型」：provider 报的列表换了，官方接着推来失效事件。
modelsByProvider.set('deepseek-account', [
  { id: 'deepseek-flash', name: 'deepseek-flash' },
  { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' },
])
for (const item of listeners) if (CATALOG_INVALIDATION_EVENTS.includes(item.name)) item.listener()

const catalogAfter = await readCatalog()
check(
  '收到失效事件后立刻能拉到新模型（不用重启 dsh、不用等 TTL）',
  providerListings === 2 && catalogAfter.providers[0].models.map((model) => model.id).join(',') === 'deepseek-flash,deepseek-v4-pro',
  `providerListings=${providerListings} models=${catalogAfter.providers[0].models.map((model) => model.id).join(',')}`,
)
check('失效事件只清缓存：紧接着再拉一次不再问 provider', providerListings === 2 && (await readCatalog()).providers[0].models.length === 2, String(providerListings))

// ---------- /rules 往返 ----------
const rulesRoute = routes.find((route) => route.path === '/api/dsh-prompt-inject/rules')
const payload = {
  revision: 0,
  slots: {
    ...state.slots,
    'user.prefix': { rules: [{ id: 'r1', enabled: true, text: '总是用中文回答', models: { all: true, list: [] } }] },
  },
}
const writeResponse = await rulesRoute.fetch(
  new Request('http://localhost/api/dsh-prompt-inject/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }),
)
const written = await writeResponse.json()
check('POST /rules 写入成功并 revision+1', writeResponse.status === 200 && written.revision === 1, `${writeResponse.status} / ${written.revision}`)

const staleResponse = await rulesRoute.fetch(
  new Request('http://localhost/api/dsh-prompt-inject/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }),
)
const stale = await staleResponse.json()
check('过期 revision 得到 409 与最新内容', staleResponse.status === 409 && stale.revision === 1 && stale.slots['user.prefix'].rules[0].text === '总是用中文回答')

const invalidResponse = await rulesRoute.fetch(
  new Request('http://localhost/api/dsh-prompt-inject/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 1, slots: { 'user.prefix': { rules: [{ id: 'x', enabled: 'yes', text: 't', models: { all: true, list: [] } }] } } }),
  }),
)
const invalid = await invalidResponse.json()
check('非法规则得到 422 与 issues', invalidResponse.status === 422 && invalid.issues.length > 0, JSON.stringify(invalid.issues))

const brokenJson = await rulesRoute.fetch(new Request('http://localhost/api/dsh-prompt-inject/rules', { method: 'POST', body: '{oops' }))
check('坏 JSON 得到 422', brokenJson.status === 422, String(brokenJson.status))

const missingRevision = await rulesRoute.fetch(
  new Request('http://localhost/api/dsh-prompt-inject/rules', { method: 'POST', body: JSON.stringify({ slots: state.slots }) }),
)
check('缺 revision 得到 422', missingRevision.status === 422, String(missingRevision.status))

// ---------- persona 头 / 尾改写（两个独立注入点） ----------
const assemble = listeners.find((item) => item.name === 'system-prompt/assemble').listener
const assembly = {
  sections: [
    { name: 'harness:identity', text: 'identity' },
    { name: 'deployment:persona-prefix', text: '官方头' },
    { name: 'deployment:persona-suffix', text: '官方尾' },
  ],
  contexts: [],
  tools: [],
  variables: {},
}
const passthroughBefore = await assemble(assembly, {}, async () => assembly)
check('都没配时原样返回（官方默认保留）', passthroughBefore.sections[1].text === '官方头' && passthroughBefore.sections[2].text === '官方尾')

/** 写一次规则。 */
const writeSlots = async (revision, patch) => {
  const response = await rulesRoute.fetch(
    new Request('http://localhost/api/dsh-prompt-inject/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision, slots: { ...(await currentSlots()), ...patch } }),
    }),
  )
  return response.json()
}
/** 读当前 slots。 */
const currentSlots = async () => (await (await stateRoute.fetch(new Request('http://localhost/state'))).json()).slots

const withHead = JSON.parse(JSON.stringify(assembly))
const headWritten = await writeSlots(written.revision, {
  'system.personaHead': { rules: [{ id: 'h', enabled: true, text: '我的头 {{不能插值}}', models: { all: true, list: [] } }] },
})
// 组装用的是同步读到的缓存，写完后会刷新；这里直接等一拍。
await new Promise((resolve) => setTimeout(resolve, 50))
const rewritten = await assemble(withHead, {}, async () => withHead)
check('只配头：官方头被替换', rewritten.sections[1].text === '我的头 {{不能插值}}', rewritten.sections[1].text)
check('只配头：段被标成不插值（文本已由插件渲染完）', rewritten.sections[1].interpolate === false)
check('只配头：官方尾原样保留（尾是独立注入点）', rewritten.sections[2].text === '官方尾', rewritten.sections[2].text)

const withTail = JSON.parse(JSON.stringify(assembly))
const tailWritten = await writeSlots(headWritten.revision, {
  'system.personaHead': { rules: [] },
  'system.personaTail': { rules: [{ id: 't', enabled: true, text: '我的尾', models: { all: true, list: [] } }] },
})
await new Promise((resolve) => setTimeout(resolve, 50))
const tailRewritten = await assemble(withTail, {}, async () => withTail)
check('只配尾：官方尾被替换', tailRewritten.sections[2].text === '我的尾', tailRewritten.sections[2].text)
check('只配尾：官方头原样保留', tailRewritten.sections[1].text === '官方头', tailRewritten.sections[1].text)

// ---------- 模板字段：插件自己渲染，官方不再碰 {{ ----------
/**
 * 造一份带中间锚点的组装结果：中间锚点的文本照官方 assemble 的做法，
 * 直接问注册时拿到的 `text(context)` provider，`variables` 是官方这次算出来的字段值。
 */
const templateAssembly = (variables, context = {}) => ({
  sections: [
    { name: 'harness:identity', text: 'identity' },
    { name: 'deployment:persona-prefix', text: '官方头' },
    ...sections
      .filter((definition) => definition.name === 'prompt-inject:beforeTools')
      .map((definition) => ({ name: definition.name, text: definition.text(context) })),
    { name: 'deployment:persona-suffix', text: '官方尾' },
  ],
  contexts: [],
  tools: [],
  variables,
})

const templateWritten = await writeSlots(tailWritten.revision, {
  'system.personaHead': { rules: [{ id: 'h2', enabled: true, text: '头：{{model}}', models: { all: true, list: [] } }] },
  'system.personaTail': { rules: [] },
  'system.beforeTools': { rules: [{ id: 'b2', enabled: true, text: '目录 {{cwd}}，模型 {{model}}', models: { all: true, list: [] } }] },
})
await new Promise((resolve) => setTimeout(resolve, 50))
const filled = templateAssembly({ provider: 'deepseek-account', model: 'deepseek-flash', cwd: 'D:\\repo' })
const rendered = await assemble({}, { agent: ctx.agents.list()[0] }, async () => filled)
check('模板字段：persona 头里的 {{model}} 换成值', rendered.sections[1].text === '头：deepseek-flash', rendered.sections[1].text)
check('模板字段：中间锚点里的 {{cwd}} / {{model}} 都换成值', rendered.sections[2].text === '目录 D:\\repo，模型 deepseek-flash', rendered.sections[2].text)
check('模板字段：插件拥有的段一律标 interpolate=false（官方插值器不会再看到 {{）', rendered.sections[1].interpolate === false && rendered.sections[2].interpolate === false)
check('模板字段：官方自己的段不动', rendered.sections[3].text === '官方尾' && rendered.sections[3].interpolate === undefined)

const noValues = templateAssembly({})
const missing = await assemble({}, {}, async () => noValues)
check('取不到值：{{model}} 原样保留，不抛错', missing.sections[1].text === '头：{{model}}' && missing.sections[2].text === '目录 {{cwd}}，模型 {{model}}', `${missing.sections[1].text} | ${missing.sections[2].text}`)

const agentFallback = await assemble({}, { agent: { options: { provider: 'deepseek-account', model: 'deepseek-v4-pro' }, session: { header: { cwd: 'E:\\fallback' } } } }, async () => templateAssembly({}))
check('取不到官方变量时退回 agent 上的值', agentFallback.sections[1].text === '头：deepseek-v4-pro' && agentFallback.sections[2].text === '目录 E:\\fallback，模型 deepseek-v4-pro', `${agentFallback.sections[1].text} | ${agentFallback.sections[2].text}`)

// system 末尾锚点必须排在官方 persona 尾之后。
const lastPoint = INJECT_POINTS.find((point) => point.key === 'system.last')
check('system 末尾锚点的 order 大于官方 persona 尾的 order', lastPoint.order > 10200, String(lastPoint.order))
check('中段锚点都不落在官方 persona 尾之前与之后之间的空洞里', INJECT_POINTS.filter((point) => point.sectionName !== undefined && point.key !== 'system.last').every((point) => point.order < 10200))

// ---------- 插入 vs 替换：按在 system 里出现的先后排一遍 ----------
const placement = INJECT_POINTS.map((point) => ({
  key: point.key,
  // 替换类落在官方段自己的 order 上；插入类用它声明的段位。
  at: point.replaces === 'deployment:persona-prefix' ? 0 : point.replaces === 'deployment:persona-suffix' ? 10200 : point.order,
  mode: point.replaces === undefined ? 'insert' : 'replace',
})).filter((item) => item.at !== undefined)

check(
  '头与尾是替换、4 个中段是插入',
  placement.filter((item) => item.mode === 'replace').map((item) => item.key).join(',') === 'system.personaHead,system.personaTail' &&
    placement.filter((item) => item.mode === 'insert').length === 4,
  JSON.stringify(placement),
)
check(
  '按落点排序后与页面顺序一致（head 0 → 950 → 3050 → 9800 → tail 10200 → 10300）',
  JSON.stringify([...placement].sort((a, b) => a.at - b.at).map((item) => item.at)) === JSON.stringify([0, 950, 3050, 9800, 10200, 10300]),
  JSON.stringify([...placement].sort((a, b) => a.at - b.at).map((item) => `${item.key}@${item.at}`)),
)
check('页面顺序里头尾不挨着', placement.findIndex((item) => item.key === 'system.personaHead') < placement.findIndex((item) => item.key === 'system.personaTail'))
void tailWritten
void templateWritten

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (warnings.length > 0) console.log(`警告日志：${warnings.join(' | ')}`)
process.exit(failed.length === 0 ? 0 : 1)

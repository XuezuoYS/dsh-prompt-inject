// host 半的接线检查：端点注册、/state 与 /rules 的真实往返（v2 的 groups）、
// system 段注册与 persona 改写、以及「模型设置变了 → 宿主目录缓存立刻失效」
// （见 verify-catalog-refresh.mjs 的客户端那一半）。用假的 ctx 跑，不碰真实 DSH。
//
// 用法：node tests/verify-host-wiring.mjs
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyPositions } from '../lib/groupConfig.js'

const home = await mkdtemp(join(tmpdir(), 'dsh-prompt-inject-home-'))
process.env.DSH_HOME = home

const { apply, inject } = await import('../lib/index.js')
const { INJECT_POINTS, middleSectionPoints, replacedSectionPoints } = await import('../lib/injectPoints.js')
const { CATALOG_INVALIDATION_EVENTS } = await import('../lib/settingsApi.js')
const { resolveSlot } = await import('../lib/groupResolver.js')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/**
 * 造一个完整组：没给的位置补默认块。
 * @param {string} id - 组 id。
 * @param {string} name - 组名。
 * @param {Record<string, { enabled: boolean, text: string }>} [positions] - 要覆盖的位置块。
 * @param {{ enabled?: boolean, models?: { all: boolean, list: string[] } }} [options] - 组级开关与作用域。
 * @returns {object} 组。
 */
const group = (id, name, positions = {}, options = {}) => ({
  id,
  name,
  enabled: options.enabled !== false,
  models: options.models ?? { all: true, list: [] },
  positions: { ...emptyPositions(), ...positions },
})

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

// ---------- /state：零组也能开 ─----------
const stateRoute = routes.find((route) => route.path === '/api/dsh-prompt-inject/state')
const readState = async () => (await stateRoute.fetch(new Request('http://localhost/api/dsh-prompt-inject/state'))).json()
const state = await readState()
check('GET /state 返回 200', state.revision === 0 && Array.isArray(state.groups) && state.groups.length === 0, `revision=${state.revision} groups=${JSON.stringify(state.groups)}`)
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

// ---------- /rules 往返（groups） ----------
const rulesRoute = routes.find((route) => route.path === '/api/dsh-prompt-inject/rules')
/**
 * 发一次 POST /rules。
 * @param {unknown} body - 请求体（对象会被序列化；字符串原样发）。
 * @returns {Promise<{ status: number, body: object }>} 状态码与解析后的响应体。
 */
const postRules = async (body) => {
  const response = await rulesRoute.fetch(
    new Request('http://localhost/api/dsh-prompt-inject/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
  return { status: response.status, body: await response.json() }
}

const legacyShape = await postRules({ revision: 0, slots: { 'user.prefix': { rules: [] } } })
check('旧 { revision, slots } 请求体得到 422（提示刷新页面）', legacyShape.status === 422, JSON.stringify(legacyShape.body))

const brokenJson = await postRules('{oops')
check('坏 JSON 得到 422', brokenJson.status === 422, String(brokenJson.status))

const missingRevision = await postRules({ groups: [] })
check('缺 revision 得到 422', missingRevision.status === 422, String(missingRevision.status))

const twoGroups = [
  group('g1', '组 1', {
    'user.prefix': { enabled: true, text: '前 1' },
    'system.beforeTools': { enabled: true, text: '中 1 {{model}}' },
    'system.personaHead': { enabled: true, text: '头 {{model}}' },
  }),
  group('g2', '组 2', {
    'user.prefix': { enabled: true, text: '前 2' },
    'system.beforeTools': { enabled: true, text: '中 2' },
    'system.personaHead': { enabled: true, text: '第二组头' },
  }),
]
const written = await postRules({ revision: 0, groups: twoGroups })
check('POST /rules 写入 groups 成功并 revision+1', written.status === 200 && written.body.revision === 1, `${written.status} / ${written.body.revision}`)
check('写入结果原样带回 groups', written.body.groups.length === 2 && written.body.groups[0].id === 'g1', JSON.stringify(written.body.groups?.map((item) => item.id)))

const afterWrite = await readState()
check('GET /state 能读回两个组', afterWrite.groups.length === 2 && afterWrite.groups[1].name === '组 2')
check(
  '两个组同一个位置按组顺序用空行拼接',
  resolveSlot(afterWrite.groups, 'user.prefix', 'deepseek-account/deepseek-flash') === '前 1\n\n前 2',
  resolveSlot(afterWrite.groups, 'user.prefix', 'deepseek-account/deepseek-flash'),
)
check(
  '组里的位置文本会在解析时按模型取值（模板字段稍后渲染）',
  resolveSlot(afterWrite.groups, 'system.beforeTools', 'deepseek-account/deepseek-flash') === '中 1 {{model}}\n\n中 2',
  resolveSlot(afterWrite.groups, 'system.beforeTools', 'deepseek-account/deepseek-flash'),
)

const staleResponse = await postRules({ revision: 0, groups: twoGroups })
check(
  '过期 revision 得到 409 与服务端最新 groups',
  staleResponse.status === 409 && staleResponse.body.revision === 1 && staleResponse.body.groups?.length === 2,
  `${staleResponse.status} / ${staleResponse.body.revision}`,
)

const invalidResponse = await postRules({
  revision: 1,
  groups: [{ ...group('bad', '坏组'), enabled: 'yes' }],
})
check('非法组（enabled 非布尔）得到 422 与 issues', invalidResponse.status === 422 && Array.isArray(invalidResponse.body.issues) && invalidResponse.body.issues.length > 0, JSON.stringify(invalidResponse.body.issues))

const notArrayResponse = await postRules({ revision: 1, groups: 'nope' })
check('groups 不是数组得到 422', notArrayResponse.status === 422, String(notArrayResponse.status))

const strayGroup = group('stray', '未知位置', { 'user.prefix': { enabled: true, text: '保留的' } })
strayGroup.positions['user.unknown'] = { enabled: true, text: '要丢掉' }
const strayResponse = await postRules({ revision: 1, groups: [strayGroup] })
check(
  '未知位置键不整包报错：200 + dropped',
  strayResponse.status === 200 && strayResponse.body.dropped.length > 0 && JSON.stringify(strayResponse.body.dropped).includes('user.unknown'),
  JSON.stringify(strayResponse.body.dropped),
)
check('未知位置键没有落进配置', (await readState()).groups[0].positions['user.unknown'] === undefined)

const emptyResponse = await postRules({ revision: 2, groups: [] })
check('空 groups 也是合法请求：200、revision+1、groups = []', emptyResponse.status === 200 && emptyResponse.body.revision === 3 && Array.isArray(emptyResponse.body.groups) && emptyResponse.body.groups.length === 0, `${emptyResponse.status} / ${JSON.stringify(emptyResponse.body)}`)
check('写完空 groups 后 /state 也是零组', (await readState()).groups.length === 0)

// ---------- 组装：零组时官方默认保留 ----------
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
const passthrough = await assemble(assembly, {}, async () => assembly)
check('零组时原样返回（官方默认保留）', passthrough.sections[1].text === '官方头' && passthrough.sections[2].text === '官方尾')

// ---------- persona 头 / 尾改写（两个独立位置） ----------
/** 等一拍，让 system 段读一次写后的配置（refresh 是异步的）。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

/** 再写一份分组，等 system 段刷新。 */
const writeGroups = async (revision, groups) => {
  const response = await postRules({ revision, groups })
  await settle()
  return response
}

const personaWrite = await writeGroups(3, twoGroups)
check('重新写入两个组（persona / 中段）', personaWrite.status === 200 && personaWrite.body.revision === 4, `${personaWrite.status}`)

const withHead = { ...JSON.parse(JSON.stringify(assembly)), variables: { provider: 'deepseek-account', model: 'deepseek-flash', cwd: 'D:\\repo' } }
const rewritten = await assemble(withHead, { agent: ctx.agents.list()[0] }, async () => withHead)
check(
  'persona 头按两个组顺序拼接并渲染模板字段',
  rewritten.sections[1].text === '头 deepseek-flash\n\n第二组头',
  rewritten.sections[1].text,
)
check('改写后的段被标成不插值（文本已由插件渲染完）', rewritten.sections[1].interpolate === false)
check('没配的官方尾原样保留（尾是独立位置）', rewritten.sections[2].text === '官方尾', rewritten.sections[2].text)

const tailWrite = await writeGroups(4, [
  group('tail', '尾巴组', { 'system.personaTail': { enabled: true, text: '我的尾' } }),
])
check('再写入只配尾的组', tailWrite.status === 200 && tailWrite.body.revision === 5, `${tailWrite.status}`)
const withTail = JSON.parse(JSON.stringify(assembly))
const tailRewritten = await assemble(withTail, {}, async () => withTail)
check('只配尾：官方尾被替换', tailRewritten.sections[2].text === '我的尾', tailRewritten.sections[2].text)
check('只配尾：官方头原样保留', tailRewritten.sections[1].text === '官方头', tailRewritten.sections[1].text)

// ---------- 模板字段：位置文本由插件渲染，官方不再碰 {{ ----------
// 回到两个组的配置，检查中间锚点的模板字段。
await writeGroups(5, twoGroups)

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

const filled = templateAssembly({ provider: 'deepseek-account', model: 'deepseek-flash', cwd: 'D:\\repo' })
const rendered = await assemble({}, { agent: ctx.agents.list()[0] }, async () => filled)
check('模板字段：persona 头里的 {{model}} 换成值', rendered.sections[1].text === '头 deepseek-flash\n\n第二组头', rendered.sections[1].text)
check('模板字段：两个组的中间锚点按顺序拼接、{{model}} 都换成值', rendered.sections[2].text === '中 1 deepseek-flash\n\n中 2', rendered.sections[2].text)
check('模板字段：插件拥有的段一律标 interpolate=false', rendered.sections[1].interpolate === false && rendered.sections[2].interpolate === false)
check('模板字段：官方自己的段不动', rendered.sections[3].text === '官方尾' && rendered.sections[3].interpolate === undefined)

const noValues = templateAssembly({})
const missing = await assemble({}, {}, async () => noValues)
check('取不到值：{{model}} 原样保留，不抛错', missing.sections[1].text === '头 {{model}}\n\n第二组头' && missing.sections[2].text === '中 1 {{model}}\n\n中 2', `${missing.sections[1].text} | ${missing.sections[2].text}`)

const agentFallback = await assemble({}, { agent: { options: { provider: 'deepseek-account', model: 'deepseek-v4-pro' }, session: { header: { cwd: 'E:\\fallback' } } } }, async () => templateAssembly({}))
check('取不到官方变量时退回 agent 上的值', agentFallback.sections[1].text === '头 deepseek-v4-pro\n\n第二组头' && agentFallback.sections[2].text === '中 1 deepseek-v4-pro\n\n中 2', `${agentFallback.sections[1].text} | ${agentFallback.sections[2].text}`)

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

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (warnings.length > 0) console.log(`警告日志：${warnings.join(' | ')}`)
process.exit(failed.length === 0 ? 0 : 1)

// 客户端半的「模型目录实时刷新」回归：
// 官方把「模型 / 设置 / 密钥变了」推给浏览器 → 插件重拉 /catalog → 卡片立刻按新目录判「已失效」。
//
// 这里要盯住两件事：
// 1. 模型设置一改就重拉（不用重启 dsh、不用刷新页面）；
// 2. 重拉**只换目录**：规则、revision、保存状态都别动——用户可能正在打字，本地乐观更新还没提交。
//
// 用法：node .agents/checks/verify-catalog-refresh.mjs
import { readFile } from 'node:fs/promises'

const { CATALOG_INVALIDATION_EVENTS } = await import('../../lib/settingsApi.js')

const problems = []
const check = (name, ok, detail) => {
  if (!ok) problems.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------- 最小 React / jsx 替身（只要 apply 能挂上就行，页面渲染不是这里的重点） ----------
const react = { useState: (initial) => [initial, () => {}], useMemo: (factory) => factory(), useRef: (initial) => ({ current: initial }) }
const jsxRuntime = { jsx: (type, props) => ({ type, props: props ?? {} }), jsxs: (type, props) => ({ type, props: props ?? {} }) }

// ---------- 加载客户端半 ----------
const source = await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8')
const registrations = []
globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }
// eslint-disable-next-line no-eval
;(0, eval)(source)

const exports = registrations[0].factory((specifier) => {
  if (specifier === 'react') return react
  if (specifier === 'react/jsx-runtime') return jsxRuntime
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return new Proxy({}, { get: () => function Stub() {} })
  throw new Error(`unexpected require: ${specifier}`)
})

// ---------- 假的宿主：/state、/catalog、/rules ----------
const CATALOG_A = { degraded: false, providers: [{ id: 'deepseek-account', displayName: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'deepseek-flash' }] }] }
const CATALOG_B = {
  degraded: false,
  providers: [{ id: 'deepseek-account', displayName: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'deepseek-flash' }, { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' }] }],
}
const STATE = {
  revision: 3,
  slots: {
    'user.prefix': { rules: [{ id: 'r1', enabled: true, text: '一条规则', models: { all: true, list: [] } }] },
    'user.suffix': { rules: [] },
  },
  fields: [],
  catalog: CATALOG_A,
}

let catalogMode = 'ok'
const requests = []
globalThis.fetch = async (url, init) => {
  requests.push(`${init?.method ?? 'GET'} ${url}`)
  if (url.endsWith('/catalog')) {
    if (catalogMode === 'fail') return { ok: false, status: 500, json: async () => ({ error: 'read-catalog-failed' }) }
    return { ok: true, status: 200, json: async () => (catalogMode === 'stale' ? CATALOG_A : CATALOG_B) }
  }
  if (init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ revision: STATE.revision + 1, slots: JSON.parse(init.body).slots }) }
  return { ok: true, status: 200, json: async () => STATE }
}
globalThis.document = { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } }

// ---------- 挂载：记录子插件注入、remote 订阅与 effect ----------
const subscriptions = []
const disposers = []
const scopedCtx = {
  remote: {
    $on: (event, listener) => {
      subscriptions.push({ event, listener })
      return () => {}
    },
  },
  on: (name, listener) => {
    subscriptions.push({ event: name, listener })
    return () => {}
  },
  effect: (body) => {
    const result = body()
    return typeof result === 'function' ? result : () => {}
  },
}

const registers = []
let injectDeps
exports.apply({
  effect: (callback) => {
    const result = callback()
    if (result !== null && typeof result === 'object' && typeof result.next === 'function') while (result.next().done !== true) {}
    return typeof result === 'function' ? result : () => {}
  },
  inject: (deps, callback) => {
    injectDeps = deps
    callback(scopedCtx)
    return () => {}
  },
  logger: () => ({ warn: () => {} }),
  slots: {
    inject: (_name, callback) => callback(),
    register: (options, component) => {
      registers.push({ options, component })
      return () => {}
    },
  },
  get: () => undefined,
})

const controller = registers[0]?.options?.inject?.().hooks?.rules
check('拿到真实的 Controller', controller !== undefined)

/** 等首次 /state 落进快照。 */
const waitFor = async (predicate, timeoutMs = 1000) => {
  const until = Date.now() + timeoutMs
  while (!predicate() && Date.now() < until) await tick(10)
  return predicate()
}

check('首次加载把目录带进快照', await waitFor(() => controller.getSnapshot().catalog.providers.length === 1))
check('子插件要的是 remote 服务', JSON.stringify(injectDeps) === JSON.stringify(['remote']), JSON.stringify(injectDeps))
check(
  '订阅了全部「目录失效」事件 + 重连补拉',
  JSON.stringify(subscriptions.map((item) => item.event).filter((event) => event !== 'connection/reset')) === JSON.stringify(CATALOG_INVALIDATION_EVENTS) && subscriptions.some((item) => item.event === 'connection/reset'),
  subscriptions.map((item) => item.event).join(','),
)

/** 触发一次推送。 */
const push = (event) => {
  for (const item of subscriptions) if (item.event === event) item.listener()
}

// ---------- 用户正在编辑（还没提交），这时模型设置变了 ----------
controller.edit('user.prefix', (list) => [...list, { id: 'r2', enabled: true, text: '正在打字…', models: { all: true, list: [] } }])
const requestsBefore = requests.filter((item) => item.endsWith('/catalog')).length
push('llm/adapters-updated')
await tick(300)

const refreshed = controller.getSnapshot()
check('收到推送后重拉了目录', requests.filter((item) => item.endsWith('/catalog')).length === requestsBefore + 1, requests.filter((item) => item.endsWith('/catalog')).join(','))
check('目录换成新的（新增的模型立刻出现在弹层里）', refreshed.catalog.providers[0].models.length === 2, JSON.stringify(refreshed.catalog.providers[0].models))
check('重拉不动规则：用户本地那份编辑还在', refreshed.slots['user.prefix'].rules.length === 2 && refreshed.slots['user.prefix'].rules[1].text === '正在打字…')
check('重拉不动 revision（乐观锁要用的还是这一版）', refreshed.revision === 3, String(refreshed.revision))
check('重拉不动保存状态（还是「保存中…」）', refreshed.status === 'pending' && refreshed.message === '保存中…', `${refreshed.status} / ${refreshed.message}`)

// ---------- 连改几下：合并成一次请求 ----------
const beforeBurst = requests.filter((item) => item.endsWith('/catalog')).length
push('settings/document-updated')
push('credentials/record-updated')
push('credentials/reference-updated')
await tick(300)
check(
  '连着推三条只重拉一次（debounce 合并）',
  requests.filter((item) => item.endsWith('/catalog')).length === beforeBurst + 1,
  requests.filter((item) => item.endsWith('/catalog')).join(','),
)

// ---------- 重连后补拉 ----------
const beforeReconnect = requests.filter((item) => item.endsWith('/catalog')).length
push('connection/reset')
await tick(300)
check('重连后补拉一次目录', requests.filter((item) => item.endsWith('/catalog')).length === beforeReconnect + 1)

// ---------- 拉失败：留旧目录，不打断用户 ----------
catalogMode = 'fail'
const snapshotBeforeFailure = controller.getSnapshot()
push('llm/adapters-updated')
await tick(300)
const afterFailure = controller.getSnapshot()
check('拉失败时保留旧目录', afterFailure.catalog.providers[0].models.length === 2)
check('拉失败不影响保存状态与规则', afterFailure.status === snapshotBeforeFailure.status && afterFailure.slots === snapshotBeforeFailure.slots)

// ---------- 老 host（没有 /catalog）也不能炸 ----------
let oldHostFetched = 0
globalThis.fetch = async (url) => {
  if (url.endsWith('/catalog')) {
    oldHostFetched += 1
    return { ok: false, status: 404, json: async () => ({ error: 'not-found' }) }
  }
  return { ok: true, status: 200, json: async () => STATE }
}
push('llm/adapters-updated')
await tick(300)
check('老 host 回 404 时静静留着旧目录（不抛错、不改状态）', oldHostFetched === 1 && controller.getSnapshot().catalog.providers[0].models.length === 2)

// ---------- 第二段：真 cordis 下「remote 服务晚到」也要订上 ----------
// 客户端半是 `ctx.inject(['remote'], ...)`：服务没挂时子插件只是待命，设置页照旧能开；
// 服务后来才挂上（插件加载顺序不保证）时，订阅必须补上。
{
  const { Context } = await import('@deepseek-ai/cordis')
  const pushed = []
  const lateRegisters = []
  const root = new Context()
  root.provide('slots', {
    inject: (_name, callback) => callback(),
    register: (options, component) => {
      lateRegisters.push({ options, component })
      return () => {}
    },
  })

  let lateCatalogFetches = 0
  globalThis.fetch = async (url) => {
    if (url.endsWith('/catalog')) {
      lateCatalogFetches += 1
      return { ok: true, status: 200, json: async () => CATALOG_B }
    }
    return { ok: true, status: 200, json: async () => STATE }
  }

  const fiber = await root.plugin({ name: 'dsh-prompt-inject', inject: exports.inject, apply: exports.apply })
  check('remote 还没挂时：设置页照样注册了', lateRegisters.length === 1)
  check('remote 还没挂时：什么都没订阅', pushed.length === 0)

  // 服务晚到（例如网关插件排在后面）。
  root.provide('remote', {
    $on: (event, listener) => {
      pushed.push({ event, listener })
      return () => {}
    },
  })
  await tick(50)
  check(
    'remote 挂上后自动补上全部订阅',
    JSON.stringify(pushed.map((item) => item.event)) === JSON.stringify(CATALOG_INVALIDATION_EVENTS),
    pushed.map((item) => item.event).join(','),
  )

  const before = lateCatalogFetches
  for (const item of pushed) if (item.event === 'settings/document-updated') item.listener()
  await tick(300)
  check('晚挂上之后推送也能换来一次重拉', lateCatalogFetches === before + 1, `${before} → ${lateCatalogFetches}`)

  await fiber.dispose()
}

const failed = problems.length
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)


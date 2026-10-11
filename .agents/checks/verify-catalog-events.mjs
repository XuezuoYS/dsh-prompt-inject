// 真 cordis 的接线回归：只用**真的** fiber / 事件总线 / effect 生命周期，
// 官方服务（llm、connection、systemPrompt、sessions）用替身。
//
// 要证的三件事：
// 1. 官方那几个事件名确实能把宿主半的目录缓存清掉（事件名写错、监听挂错 fiber 都会在这里露出来）；
// 2. 清缓存是「同步、当场」发生的——客户端收到同一条推送后立刻来拉，拿到的必须是新目录；
// 3. 插件被停用时监听器跟着消失（官方「禁用再启用」式热重载不允许攒监听器）。
//
// 事件名出处（发行包 0.2.0-rc.2）：
// - `llm/adapters-updated`：`@deepseek-ai/dsh-llm/lib/index.js` 的 `emitAdaptersUpdated()`；
// - `settings/document-updated`：`@deepseek-ai/dsh-settings/lib/index.js` 写盘后 `ownerContext.emit(...)`；
// - `credentials/record-updated` / `credentials/reference-updated`：`@deepseek-ai/dsh-credentials/lib/index.js` 的 `fanOut(...)`。
// 官方模型设置页听的正是这一套（`dsh-client-ui-settings-models` 的 `refreshIfLoaded`）。
//
// 用法：node .agents/checks/verify-catalog-events.mjs
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-prompt-inject-home-'))

const { Context } = await import('@deepseek-ai/cordis')
const pluginModule = await import('../../lib/index.js')
const { CATALOG_INVALIDATION_EVENTS } = await import('../../lib/settingsApi.js')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ---------- 先对官方那张「会推给浏览器的宿主事件」白名单 ----------
// 事件名写错在两边都不会报错：宿主照着别人的事件名挂监听 → 永远不响；
// 客户端照着一个不在白名单里的名字订阅 → 永远收不到。拿官方的声明核一遍最省事。
const { API_REMOTE_FORWARDED_EVENTS } = await import('@deepseek-ai/dsh-api-remotes')
const forwarded = new Set(API_REMOTE_FORWARDED_EVENTS.filter((item) => item.mode === 'emit').map((item) => item.event))
for (const event of CATALOG_INVALIDATION_EVENTS) {
  check(`官方确实会把 ${event} 推给浏览器（在 API_REMOTE_FORWARDED_EVENTS 里）`, forwarded.has(event))
}

/** provider → 模型列表；改它就是「模型设置变了」。 */
const models = [{ id: 'deepseek-flash', name: 'deepseek-flash' }]
const llm = {
  listProviders: () => [{ id: 'deepseek-account', displayName: 'DeepSeek 账号' }],
  listModels: async () => models,
}

const routes = []
const root = new Context()
root.provide('llm', llm)
root.provide('connection', { fetch: { register: (route) => {
  routes.push(route)
  return () => {
    const at = routes.indexOf(route)
    if (at >= 0) routes.splice(at, 1)
  }
} } })
root.provide('systemPrompt', { getSectionOrder: () => 0, section: () => () => {} })
root.provide('sessions', {})

const fiber = await root.plugin({ name: pluginModule.name, inject: pluginModule.inject, apply: pluginModule.apply })

const catalogRoute = routes.find((route) => route.path === '/api/dsh-prompt-inject/catalog')
check('真 cordis 下也注册出了 /catalog 端点', catalogRoute !== undefined, routes.map((route) => route.path).join(','))

/** 拉一次目录。 */
const readCatalog = async () => (await catalogRoute.fetch(new Request('http://localhost/api/dsh-prompt-inject/catalog'))).json()

check('初始目录是 1 个模型', (await readCatalog()).providers[0].models.length === 1)

// 模型设置变了：换掉 provider 报的列表，再照官方的做法把事件推出来
// （从另一个 fiber 上 emit，跟官方服务从自己 ctx 里 fanOut 一样）。
for (const event of CATALOG_INVALIDATION_EVENTS) {
  models.push({ id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' })
  root.extend().emit(event)
  const grown = (await readCatalog()).providers[0].models.length

  models.pop()
  root.extend().emit(event)
  const shrunk = (await readCatalog()).providers[0].models.length

  check(`${event} 一到就现算（不必等 TTL、不必重启宿主）`, grown === 2 && shrunk === 1, `grown=${grown} shrunk=${shrunk}`)
}

// 插件停用后：端点与监听器都得走。
await fiber.dispose()
check('停用后端点被摘掉', routes.every((route) => route.path !== '/api/dsh-prompt-inject/catalog'), routes.map((route) => route.path).join(','))

models.length = 0
models.push({ id: 'after-dispose', name: 'after-dispose' })
root.emit('llm/adapters-updated')
const afterDispose = await readCatalog()
check(
  '停用后事件再也不会碰这份缓存（没攒下监听器）',
  afterDispose.providers[0].models[0].id === 'deepseek-flash',
  JSON.stringify(afterDispose.providers[0].models),
)

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)

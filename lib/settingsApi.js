/**
 * `/api/dsh-prompt-inject/*` 端点：读状态、读模型目录、写规则。
 * 目录缓存由官方的「模型变了」事件失效，所以模型设置一改，界面下次来拉就是新的。
 *
 * 路径必须在 `/api` 下；鉴权由官方连接层先做（`admit()`），这里不重复写。
 * 方法只支持 `GET | HEAD | POST`。
 *
 * @module dsh-prompt-inject/settingsApi
 */

import { validateSlots } from './configValidation.js'
import { TEMPLATE_FIELDS } from './templateFields.js'

/** 端点前缀。 */
export const API_BASE = '/api/dsh-prompt-inject'

/** 模型目录的缓存时长（兜底：没有事件可听时也不会永远拿旧目录）。 */
const CATALOG_TTL_MS = 30000

/**
 * 「目录该丢了」的官方事件，四件与官方模型设置页听的是同一套：
 * - `llm/adapters-updated`：provider 路由增删改（加 provider、改模型列表后适配器重挂）；
 * - `settings/document-updated`：任何设置文档落盘（模型设置页就是在写设置）；
 * - `credentials/record-updated` / `credentials/reference-updated`：密钥变了，模型可能跟着变可用。
 *
 * 只是**清缓存**，不在事件里拉目录：没人问就不花这次开销。
 * 客户端半（`lib/client.js`）照这张表重拉 `/catalog`，两边必须逐字一致。
 */
export const CATALOG_INVALIDATION_EVENTS = [
  'llm/adapters-updated',
  'settings/document-updated',
  'credentials/record-updated',
  'credentials/reference-updated',
]

/**
 * 造一个 JSON 响应。
 * @param {unknown} body - 响应体。
 * @param {number} [status] - 状态码。
 * @returns {Response} 响应。
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * 读一次模型目录：按 provider 分组，key 用 `<provider>/<model>`。
 * 单个 provider 拉不到就跳过它并标记 degraded，不阻断整次读取。
 *
 * @param {object} llm - `ctx.llm`。
 * @returns {Promise<{ providers: Array<object>, degraded: boolean }>} 目录。
 */
async function readCatalog(llm) {
  const providers = []
  let degraded = false
  for (const provider of llm.listProviders()) {
    try {
      const models = await llm.listModels(provider.id)
      providers.push({
        id: provider.id,
        displayName: provider.displayName ?? provider.id,
        models: models.map((model) => ({ id: model.id, name: model.name })),
      })
    } catch {
      degraded = true
    }
  }
  return { providers, degraded }
}

/**
 * 取一份模型目录，带缓存：缓存空了（事件失效掉或超时）才真的去问 provider。
 *
 * @param {object} deps - 依赖。
 * @param {object} deps.ctx - 插件上下文。
 * @param {{ value: object | undefined, readAt: number }} deps.catalogCache - 目录缓存槽。
 * @returns {Promise<{ providers: Array<object>, degraded: boolean }>} 目录。
 */
async function readCatalogCached({ ctx, catalogCache }) {
  const now = Date.now()
  if (catalogCache.value === undefined || now - catalogCache.readAt > CATALOG_TTL_MS) {
    catalogCache.value = await readCatalog(ctx.llm)
    catalogCache.readAt = now
  }
  return catalogCache.value
}

/**
 * 组装 `/state` 的响应体。
 *
 * 不下发「当前模型」：多会话并行时它取的是最近活跃会话的路由，未必是用户正在看的那个，
 * 界面拿它提示反而误导，所以目录里只给「有哪些模型」和「拉全了没有」。
 *
 * @param {object} deps - 依赖。
 * @param {object} deps.ctx - 插件上下文。
 * @param {object} deps.store - ConfigStore。
 * @param {{ value: object | undefined, readAt: number }} deps.catalogCache - 目录缓存槽。
 * @returns {Promise<object>} 状态。
 */
async function readState({ ctx, store, catalogCache }) {
  const config = await store.read()
  const catalog = await readCatalogCached({ ctx, catalogCache })
  return {
    revision: config.revision,
    slots: config.slots,
    // 设置页要展示的模板字段与注释：唯一真源在 templateFields.js，客户端不再抄一份。
    fields: TEMPLATE_FIELDS,
    catalog: {
      providers: catalog.providers,
      degraded: catalog.degraded,
    },
  }
}

/**
 * 注册三个端点，并挂上「目录失效」监听。
 *
 * @param {object} ctx - 插件上下文（需要 `connection`、`llm`）。
 * @param {object} store - ConfigStore。
 * @param {(message: string, error: unknown) => void} [onWarn] - 记日志回调。
 * @param {() => void} [onWritten] - 写成功后的回调（system 段靠它刷新缓存）。
 * @returns {void}
 */
export function registerSettingsApi(ctx, store, onWarn = () => {}, onWritten = () => {}) {
  const catalogCache = { value: undefined, readAt: 0 }

  /** 把目录缓存丢掉，下一次读现算。 */
  const invalidateCatalog = () => {
    catalogCache.value = undefined
    catalogCache.readAt = 0
  }

  // 模型设置一变就丢缓存：客户端收到同一条推送后立刻来拉，拿到的就是新目录，
  // 不用等 dsh 重启，也不用等 TTL 到期。
  for (const event of CATALOG_INVALIDATION_EVENTS) {
    ctx.effect(() => ctx.on(event, invalidateCatalog), `dsh-prompt-inject: catalog stale on ${event}`)
  }

  /**
   * `/state` 的 handler。
   * @returns {Promise<Response>} 响应。
   */
  const handleState = async () => {
    try {
      return json(await readState({ ctx, store, catalogCache }))
    } catch (error) {
      onWarn('read state failed', error)
      return json({ error: 'read-state-failed', message: String(error?.message ?? error) }, 500)
    }
  }

  /**
   * `/catalog` 的 handler：只给模型目录。
   *
   * 另开一条是为了让界面**只换目录、不动规则**——设置页的规则是本地乐观更新的，
   * 整包重读会把用户还没提交的编辑冲掉。
   *
   * @returns {Promise<Response>} 响应。
   */
  const handleCatalog = async () => {
    try {
      return json(await readCatalogCached({ ctx, catalogCache }))
    } catch (error) {
      onWarn('read catalog failed', error)
      return json({ error: 'read-catalog-failed', message: String(error?.message ?? error) }, 500)
    }
  }

  /**
   * `/rules` 的 handler。
   * @param {Request} request - 请求。
   * @returns {Promise<Response>} 响应。
   */
  const handleWrite = async (request) => {
    let body
    try {
      body = await request.json()
    } catch {
      return json({ error: 'invalid-json' }, 422)
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'invalid-body' }, 422)
    const expected = body.revision
    if (!Number.isSafeInteger(expected) || expected < 0) {
      return json({ error: 'invalid-revision', issues: [{ path: 'revision', message: 'must be a non-negative integer' }] }, 422)
    }
    const { issues, slots, dropped } = validateSlots(body.slots)
    if (dropped.length > 0) onWarn(`ignored unknown injection points from an older client: ${dropped.join(', ')}`, undefined)
    if (slots === null) return json({ error: 'invalid-slots', issues, dropped }, 422)
    try {
      const written = await store.write(slots, expected)
      onWritten()
      return json({ ...written, ...(dropped.length === 0 ? {} : { dropped }) })
    } catch (error) {
      if (error?.code === 'revision-mismatch') {
        return json({ error: 'revision-mismatch', revision: error.revision, slots: error.slots }, 409)
      }
      onWarn('write rules failed', error)
      return json({ error: 'write-failed', message: String(error?.message ?? error) }, 500)
    }
  }

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: `${API_BASE}/state`,
        methods: ['GET', 'HEAD'],
        requestBody: 'buffered',
        fetch: handleState,
      }),
    'dsh-prompt-inject: GET /state',
  )

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: `${API_BASE}/catalog`,
        methods: ['GET', 'HEAD'],
        requestBody: 'buffered',
        fetch: handleCatalog,
      }),
    'dsh-prompt-inject: GET /catalog',
  )

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: `${API_BASE}/rules`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: handleWrite,
      }),
    'dsh-prompt-inject: POST /rules',
  )
}

/**
 * `/api/dsh-prompt-inject/*` 端点：读状态、写规则。
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

/** 模型目录的缓存时长。 */
const CATALOG_TTL_MS = 30000

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
  const now = Date.now()
  if (catalogCache.value === undefined || now - catalogCache.readAt > CATALOG_TTL_MS) {
    const catalog = await readCatalog(ctx.llm)
    catalogCache.value = catalog
    catalogCache.readAt = now
  }
  const catalog = catalogCache.value
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
 * 注册两个端点。
 *
 * @param {object} ctx - 插件上下文（需要 `connection`、`llm`）。
 * @param {object} store - ConfigStore。
 * @param {(message: string, error: unknown) => void} [onWarn] - 记日志回调。
 * @param {() => void} [onWritten] - 写成功后的回调（system 段靠它刷新缓存）。
 * @returns {void}
 */
export function registerSettingsApi(ctx, store, onWarn = () => {}, onWritten = () => {}) {
  const catalogCache = { value: undefined, readAt: 0 }

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
        path: `${API_BASE}/rules`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: handleWrite,
      }),
    'dsh-prompt-inject: POST /rules',
  )
}

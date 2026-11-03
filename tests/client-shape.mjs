// 客户端半的最小加载探针：只检查 __ModuleLoader__ 注册形状、槽位注册与注入面，不碰真实 DOM。
//
// 分组版要盯的东西：
// - 注入面给的是 `hooks.groups`（一个控制器），组操作全在它身上；
// - 零组的初始快照是 `groups: []`，页面别炸；
// - 内联的注入点表与 host 逐键、逐条 notice 对齐。
import { readFile } from 'node:fs/promises'

const problems = []
const check = (name, ok, detail) => {
  if (!ok) problems.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const registrations = []
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration)
    },
  },
}

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
// 与浏览器一样的执行方式：普通脚本，直接 eval 进全局。
// eslint-disable-next-line no-eval
;(0, eval)(source)

check('只注册一次', registrations.length === 1, String(registrations.length))
const registration = registrations[0]
check('注册 id 是包名', registration?.id === '@xuezuoys/dsh-prompt-inject', String(registration?.id))
check('注册带工厂函数', typeof registration?.factory === 'function')

const required = new Set()
/** 最小 React 替身：够把设置页组件跑一遍、不读真实 DOM。 */
const react = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: (factory) => factory(),
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  createElement: () => null,
}
const provided = new Map([
  ['react', react],
  ['react/jsx-runtime', { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }],
  [
    '@deepseek-ai/dsh-client-ui-primitives',
    new Proxy({}, { get: () => function Stub() {} }),
  ],
])
const exports = registration.factory((specifier) => {
  required.add(specifier)
  if (provided.has(specifier)) return provided.get(specifier)
  throw new Error(`client half required an unexpected module: ${specifier}`)
})

check('required 模块都在平台表里', [...required].every((specifier) => provided.has(specifier)), JSON.stringify([...required].sort()))
check('exports.apply 是函数', typeof exports.apply === 'function')
check('exports.inject 是 [slots]', JSON.stringify(exports.inject) === JSON.stringify(['slots']), JSON.stringify(exports.inject))

// ---------- 跑一遍 apply ----------
const slotInjects = []
const slotRegisters = []
const remoteSubscriptions = []
let effectCount = 0
/** 照 cordis 的语义跑一次 effect body（支持返回 disposer 或生成器）。 */
const runEffect = (callback) => {
  effectCount += 1
  const result = callback()
  if (result !== null && typeof result === 'object' && typeof result.next === 'function') while (result.next().done !== true) {}
  return typeof result === 'function' ? result : () => {}
}

/** 「模型变了」那个子插件拿到的注入上下文。 */
const scopedCtx = {
  remote: {
    $on: (event, listener) => {
      remoteSubscriptions.push({ event, listener })
      return () => {}
    },
  },
  on: (name, listener) => {
    remoteSubscriptions.push({ event: name, listener })
    return () => {}
  },
  effect: runEffect,
}

const ctx = {
  effect: runEffect,
  inject: (deps, callback) => {
    if (JSON.stringify(deps) !== JSON.stringify(['remote'])) problems.push(`客户端半只该 inject ['remote']，实际 ${JSON.stringify(deps)}`)
    callback(scopedCtx)
    return () => {}
  },
  logger: () => ({ warn: () => {} }),
  slots: {
    inject: (name, callback) => {
      slotInjects.push({ name, callback })
    },
    register: (options, component) => {
      slotRegisters.push({ options, component })
      return () => {}
    },
  },
  get: () => undefined,
}

/** 零组的 /state：新安装、或者用户把组全删了。 */
const stateResponse = { revision: 0, groups: [], fields: [], catalog: { providers: [], degraded: false } }
const originalFetch = globalThis.fetch
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => stateResponse })
globalThis.document = {
  createElement: () => ({ dataset: {}, remove() {} }),
  head: { appendChild() {} },
}
let applyError
try {
  exports.apply(ctx)
} catch (error) {
  applyError = error
}
check('apply() 不抛错', applyError === undefined, String(applyError?.message ?? applyError))
await new Promise((resolve) => setTimeout(resolve, 20))
globalThis.fetch = originalFetch

// ---------- 槽位注册 ----------
const injectCall = slotInjects.find((entry) => entry.name === 'settings.section')
if (injectCall === undefined) problems.push('apply() did not inject into settings.section')
else if (typeof injectCall.callback !== 'function') problems.push('slots.inject must be given a callback')
else {
  let callbackError
  try {
    injectCall.callback()
  } catch (error) {
    callbackError = error
  }
  check('slots.inject 回调不抛错', callbackError === undefined, String(callbackError?.message ?? callbackError))
  const registered = slotRegisters[0]
  if (registered === undefined) problems.push('slots.inject callback did not register anything')
  else {
    const options = registered.options
    check('槽位名是 settings.section', options?.name === 'settings.section', String(options?.name))
    check('槽位 id 是 promptInject', options?.id === 'promptInject', String(options?.id))
    check('槽位 order 是 50', options?.order === 50, String(options?.order))
    check('槽位 label 是 thunk（跟当前语言走）', typeof options?.label === 'function')
    check('注册带组件', typeof registered.component === 'function')

    const injected = typeof options?.inject === 'function' ? options.inject() : undefined
    const controller = injected?.hooks?.groups
    check('注入面暴露 hooks.groups', controller !== undefined, JSON.stringify(Object.keys(injected?.hooks ?? {})))
    const GROUP_METHODS = ['addGroup', 'editGroup', 'editPosition', 'moveGroup', 'requestRemoveGroup', 'cancelRemoveGroup', 'confirmRemoveGroup', 'openGroupScope', 'clearToast']
    const missing = GROUP_METHODS.filter((method) => typeof controller?.[method] !== 'function')
    check('控制器带齐组操作', missing.length === 0, missing.length === 0 ? 'addGroup/editGroup/editPosition/moveGroup/requestRemoveGroup/cancelRemoveGroup/confirmRemoveGroup/openGroupScope/clearToast' : `缺 ${missing.join(', ')}`)

    // 零组初始：读回来的快照是空数组，页面能拿它渲染而不炸。
    const snapshot = controller?.getSnapshot?.()
    check('零组快照：groups 是空数组', Array.isArray(snapshot?.groups) && snapshot.groups.length === 0, JSON.stringify(snapshot?.groups))
    check('零组快照：没有挂起的删除确认', snapshot?.pendingRemoveGroupId === undefined, String(snapshot?.pendingRemoveGroupId))
    check('零组快照：读配置成功', snapshot?.status === 'saved', String(snapshot?.status))

    let viewError
    try {
      registered.component({ useGroups: (selector) => selector(snapshot), ...injected })
    } catch (error) {
      viewError = error
    }
    check('设置页拿到零组快照能渲染（不炸）', viewError === undefined, String(viewError?.message ?? viewError))
  }
}

// ---------- 与 host 的「目录失效」事件表对表 ----------
// 客户端半是手写 bundle，事件名是内联复制的一份；改表时两边必须一起改。
const { CATALOG_INVALIDATION_EVENTS } = await import('../lib/settingsApi.js')
const subscribed = remoteSubscriptions.map((item) => item.event)
check(
  'client 订阅的失效事件与 host 一致',
  JSON.stringify(subscribed.filter((event) => event !== 'connection/reset')) === JSON.stringify(CATALOG_INVALIDATION_EVENTS),
  `client ${JSON.stringify(subscribed)} vs host ${JSON.stringify(CATALOG_INVALIDATION_EVENTS)}`,
)
check('client 在重连后补拉一次目录（connection/reset）', subscribed.includes('connection/reset'))

// ---------- 与 host 的注入点表对表 ----------
// client 是手写 bundle，注入点表是内联复制的一份；改表时两边必须一起改。
// 只对两件真正会出问题的事：**键集合与顺序一致**、**notice 文案一致**。
// label / hint 是给 UI 看的短文案，两边本来就按排版需要写得不同，不做约束。
const { INJECT_POINTS } = await import('../lib/injectPoints.js')
const clientTable = new Map()
{
  const tableStart = source.indexOf('const INJECT_POINTS = [')
  const tableEnd = source.indexOf('\n    ]', tableStart)
  const body = source.slice(tableStart, tableEnd === -1 ? undefined : tableEnd)
  // 每个对象以 `key: '...'` 开头，字段可能跨行（notice 就是下一行）。
  const blocks = body.split(/(?=\bkey: ')/).slice(1)
  for (const block of blocks) {
    const key = block.match(/key: '([^']+)'/)?.[1]
    if (key === undefined) continue
    const entry = {}
    for (const field of ['label', 'hint', 'notice']) {
      const value = block.match(new RegExp(`${field}: '([^']*)'`))
      if (value !== null) entry[field] = value[1]
    }
    clientTable.set(key, entry)
  }
}
check('client 内联注入点表项数与 host 一致', clientTable.size === INJECT_POINTS.length, `client ${clientTable.size} vs host ${INJECT_POINTS.length}`)
check(
  'client 内联注入点表的键与顺序一致',
  JSON.stringify([...clientTable.keys()]) === JSON.stringify(INJECT_POINTS.map((point) => point.key)),
  JSON.stringify([...clientTable.keys()]),
)
for (const point of INJECT_POINTS) {
  const client = clientTable.get(point.key)
  if (client === undefined) {
    problems.push(`client 缺少注入点 ${point.key}`)
    continue
  }
  if (client.notice !== point.notice?.zh) {
    problems.push(`${point.key} notice 不一致：client ${JSON.stringify(client.notice)} != host ${JSON.stringify(point.notice?.zh)}`)
  }
}
for (const key of ['user.prefix', 'user.suffix']) {
  const point = INJECT_POINTS.find((item) => item.key === key)
  if (point?.notice?.zh === undefined || point.notice.zh === '') problems.push(`${key} 必须带 notice（设置页要提示「不会自动清除」）`)
}

console.log(JSON.stringify({ registrations: registrations.length, requiredModules: [...required].sort(), effects: effectCount, problems }, null, 2))
process.exit(problems.length === 0 ? 0 : 1)

// 客户端半的最小加载探针：只检查 __ModuleLoader__ 注册形状与槽位注册，不碰真实 DOM。
import { readFile } from 'node:fs/promises'

const registrations = []
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration)
    },
  },
}

const source = await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8')
// 与浏览器一样的执行方式：普通脚本，直接 eval 进全局。
// eslint-disable-next-line no-eval
;(0, eval)(source)

const problems = []
if (registrations.length !== 1) problems.push(`expected exactly 1 registration, got ${registrations.length}`)
const registration = registrations[0]
if (registration?.id !== 'dsh-prompt-inject') problems.push(`registration id must be the package name, got ${String(registration?.id)}`)
if (typeof registration?.factory !== 'function') problems.push('registration must carry a factory')

const required = new Set()
const provided = new Map([
  ['react', { useState: (value) => [value, () => {}], useMemo: (fn) => fn(), useRef: (value) => ({ current: value }), createElement: () => null }],
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

if (typeof exports.apply !== 'function') problems.push('exports.apply must be a function')
if (!Array.isArray(exports.inject) || exports.inject[0] !== 'slots') problems.push(`exports.inject must be ['slots'], got ${JSON.stringify(exports.inject)}`)

const slotInjects = []
const slotRegisters = []
let effectCount = 0
const ctx = {
  effect: (callback) => {
    effectCount += 1
    const result = callback()
    return typeof result === 'function' ? result : () => {}
  },
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

const originalFetch = globalThis.fetch
globalThis.fetch = async () => ({ ok: false, status: 0, json: async () => ({}) })
globalThis.document = {
  createElement: () => ({ dataset: {}, remove() {} }),
  head: { appendChild() {} },
}
try {
  exports.apply(ctx)
} catch (error) {
  problems.push(`apply() threw: ${error?.message ?? error}`)
}
globalThis.fetch = originalFetch

const injectCall = slotInjects.find((entry) => entry.name === 'settings.section')
if (injectCall === undefined) problems.push('apply() did not inject into settings.section')
else if (typeof injectCall.callback !== 'function') problems.push('slots.inject must be given a callback')
else {
  try {
    injectCall.callback()
  } catch (error) {
    problems.push(`slots.inject callback threw: ${error?.message ?? error}`)
  }
  const registered = slotRegisters[0]
  if (registered === undefined) problems.push('slots.inject callback did not register anything')
  else {
    const options = registered.options
    if (options?.name !== 'settings.section') problems.push('slot registration must name settings.section')
    if (options?.id !== 'promptInject') problems.push(`slot registration id must be promptInject, got ${String(options?.id)}`)
    if (options?.order !== 50) problems.push(`slot registration order should be 50, got ${String(options?.order)}`)
    if (typeof options?.label !== 'function') problems.push('slot label must be a thunk (locale follows the active language)')
    if (typeof registered.component !== 'function') problems.push('slot registration must carry a component')
    const injected = typeof options?.inject === 'function' ? options.inject() : undefined
    if (injected?.hooks?.rules === undefined) problems.push('slot inject face must expose hooks.rules')
    if (typeof injected?.editRules !== 'function') problems.push('slot inject face must expose editRules')
    if (typeof injected?.openModelRule !== 'function') problems.push('slot inject face must expose openModelRule')
    if (typeof injected?.togglePanel !== 'function') problems.push('slot inject face must expose togglePanel')
  }
}

// ---------- 与 host 的注入点表对表 ----------
// client 是手写 bundle，注入点表是内联复制的一份；改表时两边必须一起改。
// 只对两件真正会出问题的事：**键集合一致**、**notice 文案一致**。
// label / hint 是给 UI 看的短文案，两边本来就按排版需要写得不同，不做约束。
const { INJECT_POINTS } = await import('../../lib/injectPoints.js')
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
if (clientTable.size !== INJECT_POINTS.length) {
  problems.push(`client INJECT_POINTS 有 ${clientTable.size} 项，host 有 ${INJECT_POINTS.length} 项`)
}
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

console.log(JSON.stringify({
  registrations: registrations.length,
  requiredModules: [...required].sort(),
  effects: effectCount,
  notices: [...clientTable].filter(([, entry]) => entry.notice !== undefined).map(([key]) => key),
  problems,
}, null, 2))

process.exit(problems.length === 0 ? 0 : 1)

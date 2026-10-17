// 用**官方 0.2.1 的浏览器模块系统**跑一遍插件的 lib/client.js：
//   - 注册形状（`window.__ModuleLoader__.load({ id, factory })`）还能不能被识别；
//   - factory 里的 require（react / react/jsx-runtime / primitives）是否都落在平台 seed 上；
//   - package.json 的 `dsh.client` 声明能不能过官方的 parseDshClient；
//   - `dsh.client.inject` 里不是 boot graph 行的条目会被安静忽略（0.2.1 语义）；
//   - 缺了 seed 时 require 会立刻报 “missed the module table”（负向对照，证明 primitives 只能由 seed 给）。
//
// 这是一个**手工探针**，没接进 run.mjs（要跑得先有官方包：见 .agents/checks/README.md 第二段）。
// 用法：node .agents/checks/verify-client-modules.mjs
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const problems = []
const check = (name, ok, detail) => {
  if (!ok) problems.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const pluginPath = join(repoRoot, 'lib', 'client.js')
const pluginSource = readFileSync(pluginPath, 'utf8')
const pluginManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

// ---------- 找官方 0.2.1 的 client-modules（没有就跳过，别把探针当红） ----------
let modulesPath
try {
  const packageJsonPath = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-client-modules/package.json'))
  modulesPath = join(dirname(packageJsonPath), 'lib', 'client.js')
} catch {
  modulesPath = undefined
}
if (modulesPath === undefined || !existsSync(modulesPath)) {
  console.log('跳过：找不到 @deepseek-ai/dsh-client-modules（先按 .agents/checks/README.md 第二段挂官方包）')
  process.exit(0)
}
console.log(`官方模块系统：${modulesPath}`)

// ---------- 极简浏览器环境 ----------
globalThis.document = {
  createElement: () => ({ dataset: {}, remove() {} }),
  head: { appendChild() {} },
  querySelectorAll: () => [],
}
const registrations = []
globalThis.window = { __ModuleLoader__: { load(registration) { registrations.push(registration) } } }

// ---------- 加载官方 browser 模块系统 ----------
// eslint-disable-next-line no-eval
;(0, eval)(readFileSync(modulesPath, 'utf8'))
const bootstrapRegistration = registrations.find((item) => item.id === '@deepseek-ai/dsh-client-modules')
check('能加载官方的 client-modules 浏览器 bundle', bootstrapRegistration !== undefined)
const bootstrapExports = bootstrapRegistration.factory((specifier) => {
  throw new Error(`bootstrap factory unexpectedly required ${specifier}`)
})
check('官方 bundle 导出 createClientModuleSystem', typeof bootstrapExports.createClientModuleSystem === 'function')

// ---------- 平台 seed 表（形状同 live 前端 SZ()，只放插件用到的） ----------
const jsx = (type, props) => ({ type, props })
const primitives = new Proxy({}, { get: (_target, key) => (typeof key === 'string' ? function Stub() {} : undefined) })
const staticModules = {
  react: { useRef: (value) => ({ current: value }), useState: (value) => [value, () => {}], useMemo: (factory) => factory(), Fragment: 'Fragment' },
  'react/jsx-runtime': { jsx, jsxs: jsx },
  '@deepseek-ai/dsh-client-ui-primitives': primitives,
}

// ---------- package.json 的 dsh.client 声明 ----------
const decl = bootstrapExports.parseDshClient(pluginManifest.name, pluginManifest.dsh?.client)
check('parseDshClient 接受插件的 dsh.client 声明', decl?.platform === 'web', JSON.stringify(decl))
check('声明里没有 external（用到的 react / primitives 都是平台 seed）', decl?.external === undefined || decl.external.length === 0, JSON.stringify(decl))

// ---------- 合成 boot graph：插件行 + inject 里的 settings 行 ----------
const boot = {
  rev: 'check-rev',
  release: { version: '0.2.1-rc.2' },
  entries: [
    { id: pluginManifest.name, url: `plugins/${pluginManifest.name}/client.js?rev=1`, rev: '1', inject: decl?.inject ?? [], external: decl?.external ?? [] },
  ],
  batches: [{
    phase: 'application',
    url: 'plugins/??check-batch',
    rev: 'check-batch',
    entries: [pluginManifest.name],
  }],
}
for (const dependency of decl?.inject ?? []) {
  boot.entries.push({ id: dependency, url: `plugins/${dependency}/client.js?rev=1`, rev: '1' })
  boot.batches[0].entries.push(dependency)
}

const loadedUrls = []
/** 一个 combo 脚本：注册注入依赖的假 factory，再执行插件自己的 bundle。 */
const runCombo = () => {
  for (const dependency of decl?.inject ?? []) {
    globalThis.window.__ModuleLoader__.load({ id: dependency, factory: () => ({ apply() {} }) })
  }
  // eslint-disable-next-line no-eval
  ;(0, eval)(pluginSource)
}
const loadBundle = async (url) => {
  loadedUrls.push(url)
  runCombo()
}

const facade = globalThis.window.__ModuleLoader__
facade.mode = 'queue'
facade.pendingQueue = []
facade.load = (registration) => {
  facade.pendingQueue.push(registration)
}
const system = bootstrapExports.createClientModuleSystem(
  facade,
  { id: '@deepseek-ai/dsh-client-modules', exports: bootstrapExports },
  { boot, staticModules, loadBundle },
)

const pluginExports = await system.import(pluginManifest.name)
check('官方模块系统 import 插件成功', pluginExports !== undefined, String(system.importError(pluginManifest.name)?.message))
check('插件导出 apply', typeof pluginExports.apply === 'function')
check('插件注入列表只有 slots（remote 走嵌套 inject）', JSON.stringify(pluginExports.inject) === '["slots"]', JSON.stringify(pluginExports.inject))
check('import 没有记录失败', system.importError(pluginManifest.name) === undefined, String(system.importError(pluginManifest.name)?.message))

const record = system.loadCache.get(pluginManifest.name)
const edges = [...(record?.edges ?? [])].sort()
check(
  'factory 的 require 全部落在平台 seed 上',
  JSON.stringify(edges) === JSON.stringify(['@deepseek-ai/dsh-client-ui-primitives', 'react', 'react/jsx-runtime']),
  JSON.stringify(edges),
)
check(
  'inject 里的 boot graph 行先被装载（0.2.1 的 ordering 语义）',
  (decl?.inject ?? []).every((dependency) => system.factories.has(dependency)),
  JSON.stringify(loadedUrls),
)

// ---------- 负向对照：seed 里没有 primitives 时必须立刻炸 ----------
{
  const freshRegistrations = []
  globalThis.window = { __ModuleLoader__: { load: (registration) => freshRegistrations.push(registration) } }
  // eslint-disable-next-line no-eval
  ;(0, eval)(readFileSync(modulesPath, 'utf8'))
  const freshBootstrap = freshRegistrations.find((item) => item.id === '@deepseek-ai/dsh-client-modules')
  const freshExports = freshBootstrap.factory((specifier) => {
    throw new Error(specifier)
  })
  const freshFacade = globalThis.window.__ModuleLoader__
  freshFacade.mode = 'queue'
  freshFacade.pendingQueue = []
  freshFacade.load = (registration) => {
    freshFacade.pendingQueue.push(registration)
  }
  const freshSystem = freshExports.createClientModuleSystem(
    freshFacade,
    { id: '@deepseek-ai/dsh-client-modules', exports: freshExports },
    {
      boot: {
        ...boot,
        entries: [boot.entries[0]],
        batches: [{ ...boot.batches[0], entries: [pluginManifest.name] }],
      },
      staticModules: { react: staticModules.react, 'react/jsx-runtime': staticModules['react/jsx-runtime'] },
      loadBundle: async () => {
        // eslint-disable-next-line no-eval
        ;(0, eval)(pluginSource)
      },
    },
  )
  let message
  try {
    await freshSystem.import(pluginManifest.name)
  } catch (error) {
    message = String(error?.message ?? error)
  }
  check('负向对照：没有 seed 时 require 立刻失败', message?.includes('missed the module table') === true, message)
}

// ---------- 用插件自己的 require 链路跑 apply，过一遍槽位注册 ----------
{
  const slotInjects = []
  const slotRegisters = []
  globalThis.fetch = async () => ({ ok: false, status: 0, json: async () => ({}) })
  const runEffect = (callback) => {
    const result = callback()
    return typeof result === 'function' ? result : () => {}
  }
  pluginExports.apply({
    effect: runEffect,
    inject: (_deps, callback) => {
      callback({ remote: { $on: () => () => {} }, on: () => () => {}, effect: runEffect })
      return () => {}
    },
    logger: () => ({ warn: () => {} }),
    slots: {
      inject: (name, callback) => slotInjects.push({ name, callback }),
      register: (options, component) => {
        slotRegisters.push({ options, component })
        return () => {}
      },
    },
  })
  const injectCall = slotInjects.find((item) => item.name === 'settings.section')
  injectCall?.callback()
  const registered = slotRegisters[0]
  check('apply() 注册进 settings.section', injectCall !== undefined)
  check(
    '注册面形状 = 0.2.1 官方样例（name/id/order/label 函数/inject 函数）',
    registered?.options?.name === 'settings.section' &&
      registered?.options?.id === 'promptInject' &&
      typeof registered?.options?.label === 'function' &&
      typeof registered?.options?.inject === 'function',
    JSON.stringify({ name: registered?.options?.name, id: registered?.options?.id, order: registered?.options?.order }),
  )
  const face = registered?.options?.inject?.()
  check(
    'inject 面 expose hooks.rules 与四个动作',
    face?.hooks?.rules !== undefined &&
      typeof face?.editRules === 'function' &&
      typeof face?.openModelRule === 'function' &&
      typeof face?.togglePanel === 'function',
  )
}

console.log(`\n${problems.length === 0 ? '全部通过' : `${problems.length} 项失败`}`)
process.exit(problems.length === 0 ? 0 : 1)

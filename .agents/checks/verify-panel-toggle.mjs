// 控制器级回归测试：折叠按钮必须能来回切。
//
// 上一版的 bug 就出在这一层：视图把「当前是否展开」当第二个参数传给注入面，而注入面是
// 逐个方法包一层转发（`(pointKey) => controller.togglePanel(pointKey)`），多余参数被丢掉，
// 于是控制器永远收到 undefined、每次都往「展开」翻 —— 点开就再也关不上。
//
// 这里用真实的 Controller（通过 `slots.register` 的 inject 面拿到），按真实链路走一遍：
// 点标题 → 控制器发布新快照 → 用新快照重渲染 → 卡片出现/消失。
//
// 用法：node .agents/checks/verify-panel-toggle.mjs
import { readFile } from 'node:fs/promises'

const problems = []
const check = (name, ok, detail) => {
  if (!ok) problems.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 注入点键 → 页面上的标题文案。 */
const LABELS = {
  'user.prefix': '用户前置词',
  'user.suffix': '用户后置词',
  'system.personaHead': 'system 头部',
  'system.beforeTools': '工具说明之前',
  'system.afterTools': '工具说明之后',
  'system.middle': '结构化输出之前',
  'system.personaTail': 'system 尾部',
  'system.last': 'system 最末尾',
}

// ---------- 最小 React / jsx 替身 ----------
const react = { useState: (initial) => [initial, () => {}], useMemo: (factory) => factory(), useRef: (initial) => ({ current: initial }), createElement: () => null }
const jsxRuntime = { jsx: (type, props) => ({ type, props: props ?? {} }), jsxs: (type, props) => ({ type, props: props ?? {} }) }

function render(node, keep = () => false) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((item) => render(item, keep))
  if (typeof node.type === 'function') {
    if (keep(node.type.name ?? String(node.type))) return node
    return render(node.type({ ...(node.props ?? {}), key: undefined }), keep)
  }
  return { ...node, props: { ...(node.props ?? {}), children: render(node.props?.children, keep) } }
}

function findAll(node, predicate, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  findAll(node.props?.children, predicate, out)
  return out
}

function makePrimitives() {
  const stub = (name) => {
    const Component = function Stub(props) {
      return { type: name, props: { ...(props ?? {}) } }
    }
    Component.displayName = name
    return Component
  }
  const Toast = function ToastSpy(props) {
    primitives.lastToastProps = props
    return { type: 'Toast', props: { ...(props ?? {}) } }
  }
  Toast.displayName = 'Toast'
  return {
    Button: stub('Button'),
    Switch: stub('Switch'),
    Tag: stub('Tag'),
    Input: stub('Input'),
    Checkbox: stub('Checkbox'),
    Modal: stub('Modal'),
    Toast,
    IconChevronUpOutlineRegular: stub('IconChevronUpOutlineRegular'),
    IconChevronDownOutlineRegular: stub('IconChevronDownOutlineRegular'),
    IconChevronRightOutlineRegular: stub('IconChevronRightOutlineRegular'),
    IconCopyOutlineRegular: stub('IconCopyOutlineRegular'),
    IconCloseOutlineRegular: stub('IconCloseOutlineRegular'),
  }
}

/** 传给客户端半的原语替身（Toast 会把 props 写回来）。 */
const primitives = makePrimitives()

// ---------- 加载客户端半并挂载 ----------
const source = await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8')
const registrations = []
globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }
// eslint-disable-next-line no-eval
;(0, eval)(source)

const exports = registrations[0].factory((specifier) => {
  if (specifier === 'react') return react
  if (specifier === 'react/jsx-runtime') return jsxRuntime
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require: ${specifier}`)
})

const RULES = [{ id: 'r1', enabled: true, text: '一条规则', models: { all: true, list: [] } }]

/**
 * 造一份 slots。
 * @param {Array<object>} rules - 用户前置词下的规则。
 * @returns {object} slots。
 */
function slotsWith(rules) {
  const slots = {}
  for (const key of Object.keys(LABELS)) slots[key] = { rules: [] }
  slots['user.prefix'] = { rules }
  return slots
}

const posts = []
const stateResponse = { revision: 3, slots: slotsWith(RULES), catalog: { providers: [], degraded: false } }
globalThis.fetch = async (url, init) => {
  if (init?.method === 'POST') {
    posts.push(JSON.parse(init.body))
    return { ok: true, status: 200, json: async () => ({ revision: stateResponse.revision + 1, slots: JSON.parse(init.body).slots }) }
  }
  return { ok: true, status: 200, json: async () => stateResponse }
}
globalThis.document = { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } }

const registers = []
exports.apply({
  effect: (callback) => {
    const result = callback()
    if (result !== null && typeof result === 'object' && typeof result.next === 'function') while (result.next().done !== true) {}
    return typeof result === 'function' ? result : () => {}
  },
  slots: {
    inject: (_name, callback) => callback(),
    register: (options, component) => {
      registers.push({ options, component })
      return () => {}
    },
  },
  get: () => undefined,
})

const SettingsView = registers[0].component
const face = registers[0].options.inject()
const controller = face.hooks.rules

check('注入面暴露了 togglePanel', typeof face.togglePanel === 'function')

/** 模拟渲染器的标准钩子：拿控制器当前快照（并订阅，见下面的 seen）。 */
const useRules = (selector) => selector(controller.getSnapshot())
const seen = []
const unsubscribe = controller.subscribe(() => seen.push(controller.getSnapshot()))

/** 当前快照下渲染一次。 */
const tree = () => render(SettingsView({ useRules, ...face }))

/** 找某个注入点的小节标题按钮。 */
const headerOf = (pointKey) =>
  findAll(tree(), (node) => node.props?.['aria-expanded'] !== undefined).find((node) =>
    findAll(node, (child) => typeof child.props?.children === 'string' && child.props.children === LABELS[pointKey]).length > 0,
  )

/** 某个注入点此刻是否展开。 */
const isOpen = (pointKey) => {
  const head = headerOf(pointKey)
  if (head === undefined) throw new Error(`找不到 ${pointKey} 的标题`)
  return head.props['aria-expanded'] === 'true'
}

/** 此刻渲染出的规则卡片数量。 */
const cardCount = () => findAll(tree(), (node) => typeof node.props?.className === 'string' && node.props.className === 'dshpi-card').length

/** 点某个注入点的小节标题（走真实 onClick）。 */
function clickHeader(pointKey) {
  const head = headerOf(pointKey)
  if (head === undefined) throw new Error(`找不到 ${pointKey} 的标题`)
  head.props.onClick()
}

// apply 时已经发起了首次加载，等它落地（否则快照里 slots 还是空的）。
await new Promise((resolve) => setTimeout(resolve, 50))
check('首次加载完成，快照里有规则', controller.getSnapshot().slots['user.prefix'].rules.length === 1, JSON.stringify(controller.getSnapshot().slots['user.prefix']))
check('初始快照里 panels 是空表（跟随默认）', Object.keys(controller.getSnapshot().panels).length === 0)

// ---------- 有规则：默认展开 → 点一下收起 → 再点展开 ----------
check('有规则的注入点默认展开', isOpen('user.prefix') === true)
check('默认展开时能看到规则卡片', cardCount() === 1, String(cardCount()))

clickHeader('user.prefix')
check('点一下：panels 明确记成 false', controller.getSnapshot().panels['user.prefix'] === false, JSON.stringify(controller.getSnapshot().panels))
check('点一下：小节收起', isOpen('user.prefix') === false)
check('收起后卡片不再渲染', cardCount() === 0, String(cardCount()))
check('每次点击都通知了订阅者', seen.length >= 1, String(seen.length))

clickHeader('user.prefix')
check('再点一下：panels 翻回 true', controller.getSnapshot().panels['user.prefix'] === true, JSON.stringify(controller.getSnapshot().panels))
check('再点一下：小节又展开', isOpen('user.prefix') === true)
check('展开后卡片回来', cardCount() === 1, String(cardCount()))

// ---------- 没有规则：默认收起 → 点一下展开 → 再点收起 ----------
check('空的注入点默认收起', isOpen('user.suffix') === false)
clickHeader('user.suffix')
check('空的注入点点一下能展开', isOpen('user.suffix') === true)
clickHeader('user.suffix')
check('空的注入点再点一下能收起（原 bug：关不上）', isOpen('user.suffix') === false)

// ---------- 连续来回点，不能卡住 ----------
const flips = []
for (let index = 0; index < 6; index += 1) {
  clickHeader('user.suffix')
  flips.push(isOpen('user.suffix'))
}
check('连续点 6 次：状态严格交替', JSON.stringify(flips) === JSON.stringify([true, false, true, false, true, false]), JSON.stringify(flips))

// ---------- 各注入点互不影响 ----------
clickHeader('user.prefix')
check(
  '收起 user.prefix 不影响别的注入点',
  isOpen('user.prefix') === false && isOpen('user.suffix') === false && Object.keys(controller.getSnapshot().panels).length === 2,
  JSON.stringify(controller.getSnapshot().panels),
)

// ---------- 删除 → 撤销 ----------
primitives.lastToastProps = undefined
face.removeRule('user.prefix', RULES[0], 0)
check('删除后规则从 slots 里消失', controller.getSnapshot().slots['user.prefix'].rules.length === 0)
check('删除后快照里挂着提示', controller.getSnapshot().toast?.text === '已删除 1 条规则', JSON.stringify(controller.getSnapshot().toast))
render(tree())
const undoActions = primitives.lastToastProps?.actions
check('删除提示带「撤销」', Array.isArray(undoActions) && undoActions[0]?.label === '撤销', JSON.stringify(primitives.lastToastProps))
await new Promise((resolve) => setTimeout(resolve, 600))
const postsAfterDelete = posts.length
undoActions[0].onClick()
check('点撤销：规则回到原来的位置', controller.getSnapshot().slots['user.prefix'].rules[0]?.id === 'r1', JSON.stringify(controller.getSnapshot().slots['user.prefix'].rules))
check('点撤销：提示被收掉', controller.getSnapshot().toast === undefined)
// 撤销走的是同一套 debounce 保存，等它排出去。
await new Promise((resolve) => setTimeout(resolve, 600))
check('点撤销：确实又排了一次保存', posts.length > postsAfterDelete, `posts ${postsAfterDelete} → ${posts.length}`)

// ---------- 提交上去的 payload 只含已知键 ----------
if (posts.length > 0) {
  const keys = Object.keys(posts[posts.length - 1].slots)
  check('提交的 slots 只含 8 个已知注入点', keys.length === 8 && !keys.includes('system.persona'), keys.join(','))
}

unsubscribe()
// 清掉待提交的 debounce，避免进程被定时器吊着。
controller.clearToast()

console.log(`\n${problems.length === 0 ? '全部通过' : `${problems.length} 项失败`}`)
process.exit(problems.length === 0 ? 0 : 1)

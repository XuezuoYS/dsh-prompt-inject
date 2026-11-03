// 轻量渲染探针：把分组设置页渲染成纯文本 / 元素清单，检查结构、文案与交互接线。
//
// 只 stub React / jsx-runtime / 官方原语：`jsx(type, props)` 遇到函数组件就继续往里渲染
// （`keep` 可以指定某些组件不展开，方便直接读它收到的 props），不需要 DOM，也不需要 DSH 运行时。
//
// 页面形状（分组版）：顶栏（悬浮 + 模板字段下拉）→ 若干组卡片 → 每组 8 个位置行。
// 零组时只给一块居中空状态。
//
// 用法：node tests/verify-card-render.mjs
import { readFile } from 'node:fs/promises'
import { TEMPLATE_FIELDS } from '../lib/templateFields.js'
import { INJECT_POINTS } from '../lib/injectPoints.js'

const problems = []
const check = (name, ok, detail) => {
  if (!ok) problems.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const POINT_KEYS = INJECT_POINTS.map((point) => point.key)
/** 行标题用注入点表的中文短标签（client 内联表与 host 的 label 一致）。 */
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
// 有状态版：模板字段下拉的开合、作用域弹层的草稿都靠 useState。
// 槽位按下标分配（同 React 的 hook 顺序），stateSlots 跨渲染保留，stateIndex 每趟渲染清零。
let stateSlots = []
let stateIndex = 0
let effectSlots = []
let effectIndex = 0
const react = {
  useState: (initial) => {
    const index = stateIndex++
    if (stateSlots[index] === undefined) stateSlots[index] = [typeof initial === 'function' ? initial() : initial]
    return [
      stateSlots[index][0],
      (next) => {
        stateSlots[index][0] = typeof next === 'function' ? next(stateSlots[index][0]) : next
      },
    ]
  },
  // 每个渲染先清理上一趟同下标的 effect 再重跑：够探针模拟「Escape / 点外面收菜单」。
  useEffect: (body) => {
    const index = effectIndex++
    if (effectSlots[index]?.cleanup !== undefined) effectSlots[index].cleanup()
    const cleanup = body()
    effectSlots[index] = { cleanup: typeof cleanup === 'function' ? cleanup : undefined }
  },
  useMemo: (factory) => factory(),
  // 真的 ref 在无 DOM 环境里不会被挂上元素，客户端半的「插到光标处」会走回退链。
  // 探针在 render() 里自己调用 ref，并把假元素挂在 `__element` 上给测试当光标用。
  useRef: (initial) => ({ current: initial }),
  Fragment: Symbol('Fragment'),
  createElement: () => null,
}

const jsxRuntime = {
  jsx: (type, props) => ({ type, props: props ?? {} }),
  jsxs: (type, props) => ({ type, props: props ?? {} }),
}

/**
 * 渲染一个元素：函数组件继续展开，DOM 元素原样返回。
 * @param {*} node - 元素。
 * @param {(name: string) => boolean} [keep] - 返回 true 的函数组件保持不展开。
 * @returns {*} 展开结果。
 */
function render(node, keep = () => false) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((item) => render(item, keep))
  if (typeof node.type === 'function') {
    // 官方原语替身的函数名就是它声明的名字（`Stub`）。
    if (keep(node.type.name ?? String(node.type))) return node
    return render(node.type({ ...(node.props ?? {}), key: undefined }), keep)
  }
  const rendered = { ...node, props: { ...(node.props ?? {}), children: render(node.props?.children, keep) } }
  // 模拟 React 的 ref 回调：假元素的光标默认在文本末尾（和打字后的真实情况一致）。
  if (typeof rendered.props.ref === 'function') {
    const value = typeof rendered.props.value === 'string' ? rendered.props.value : ''
    const element = {
      value,
      selectionStart: value.length,
      selectionEnd: value.length,
      focus() {},
      setSelectionRange() {},
    }
    rendered.__element = element
    rendered.props.ref(element)
  }
  return rendered
}

/**
 * 在一棵树里收集所有满足条件的节点。
 * @param {*} node - 元素树。
 * @param {(node: object) => boolean} predicate - 判定条件。
 * @param {object[]} [out] - 收集结果。
 * @returns {object[]} 命中的节点。
 */
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

/** 树里所有字符串。 */
function stringsOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) stringsOf(item, out)
    return out
  }
  stringsOf(node.props?.children, out)
  return out
}

/** 节点的 class 列表里有没有某一项（允许 `a b` 多个）。 */
const hasClass = (node, name) => typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes(name)

/** 按 class 收集（整页或某棵子树）。 */
const byClass = (node, name) => findAll(node, (item) => hasClass(item, name))

/** 树里所有 className。 */
function classNamesOf(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) classNamesOf(item, out)
    return out
  }
  if (typeof node.props?.className === 'string') out.push(node.props.className)
  classNamesOf(node.props?.children, out)
  return out
}

/** 官方原语替身：渲染成带名字的元素，props 原样保留。未知原语按需生成。 */
function makePrimitives() {
  const stub = (name) => {
    const Component = function Stub(props) {
      return { type: name, props: { ...(props ?? {}) } }
    }
    Component.displayName = name
    return Component
  }
  const Toast = function ToastSpy(props) {
    // Toast 是个函数组件，只有渲染时才知道它收到什么；写回同一个对象上供断言读取。
    primitives.lastToastProps = props
    return { type: 'Toast', props: { ...(props ?? {}) } }
  }
  Toast.displayName = 'Toast'
  const table = {
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
  // 新 UI 可能用到别的图标：没列出来的按名字现造一个，避免把「原语没 stub」当成真 bug。
  return new Proxy(table, {
    get(target, key) {
      if (key === 'lastToastProps') return target.lastToastProps
      if (typeof key !== 'string') return undefined
      if (!(key in target)) target[key] = stub(key)
      return target[key]
    },
    set(target, key, value) {
      target[key] = value
      return true
    },
  })
}

/** 传给客户端半的那一份原语替身（Toast 会把 props 写回来）。 */
const primitives = makePrimitives()

// ---------- 加载客户端半 ----------
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
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

/** document 监听登记表：effect 挂的「点外面 / Escape 收菜单」从这里取。 */
const docListeners = new Map()

/** 每个场景前重置 state/effect 替身与 document 监听。 */
function resetProbe() {
  stateSlots = []
  stateIndex = 0
  for (const slot of effectSlots) slot?.cleanup?.()
  effectSlots = []
  effectIndex = 0
  docListeners.clear()
  primitives.lastToastProps = undefined
  if (globalThis.document !== undefined) globalThis.document.activeElement = undefined
}

/** 渲染一整页：每趟把 hook 下标清零（状态留在 stateSlots 里跨渲染用）。 */
function renderPage(tree) {
  stateIndex = 0
  effectIndex = 0
  return render(tree)
}

const registers = []
globalThis.fetch = async () => ({ ok: false, status: 0, json: async () => ({}) })
globalThis.document = {
  createElement: () => ({ dataset: {}, remove() {} }),
  head: { appendChild() {} },
  addEventListener: (name, listener) => {
    if (!docListeners.has(name)) docListeners.set(name, new Set())
    docListeners.get(name).add(listener)
  },
  removeEventListener: (name, listener) => {
    docListeners.get(name)?.delete(listener)
  },
}
exports.apply({
  effect: (callback) => {
    const result = callback()
    if (result !== null && typeof result === 'object' && typeof result.next === 'function') while (result.next().done !== true) {}
    return typeof result === 'function' ? result : () => {}
  },
  // 「模型变了」那个子插件：这里只要不炸就行，真行为在 verify-catalog-refresh.mjs 里测。
  inject: (_deps, callback) => {
    callback({
      remote: { $on: () => () => {} },
      on: () => () => {},
      effect: (body) => {
        const result = body()
        return typeof result === 'function' ? result : () => {}
      },
    })
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

const SettingsView = registers[0]?.component
check('拿到设置页组件', typeof SettingsView === 'function')

// ---------- 场景辅助 ----------
const CATALOG = {
  degraded: false,
  providers: [
    {
      id: 'deepseek-account',
      displayName: 'DeepSeek',
      models: [
        { id: 'deepseek-flash', name: 'deepseek-flash' },
        { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' },
        { id: 'deepseek-v4-lite', name: 'deepseek-v4-lite' },
      ],
    },
  ],
}
const FLASH = 'deepseek-account/deepseek-flash'
const PRO = 'deepseek-account/deepseek-v4-pro'

/** 造一份完整位置表。 */
function basePositions() {
  const positions = {}
  for (const key of POINT_KEYS) positions[key] = { enabled: false, text: '' }
  return positions
}

/**
 * 造一个组。
 * @param {object} [patch] - 覆盖的字段；`positions` 会与默认位置表合并。
 * @returns {object} 组。
 */
function makeGroup(patch = {}) {
  return {
    id: 'g1',
    name: '工作',
    enabled: true,
    models: { all: true, list: [] },
    positions: basePositions(),
    ...patch,
    positions: { ...basePositions(), ...(patch.positions ?? {}) },
  }
}

/** 造一个「某个位置开着且有正文」的组。 */
function groupWithText(id, name, pointKey, text) {
  return makeGroup({ id, name, positions: { [pointKey]: { enabled: true, text } } })
}

/**
 * 造一份页面状态。
 * @param {Array<object>} groups - 组列表。
 * @param {object} [patch] - 额外覆盖的字段（pendingRemoveGroupId / toast / …）。
 * @returns {object} 状态。
 */
function makeState(groups, patch = {}) {
  return {
    status: 'saved',
    message: '已保存',
    revision: 1,
    groups,
    fields: TEMPLATE_FIELDS,
    catalog: CATALOG,
    pendingRemoveGroupId: undefined,
    openGroupScope: undefined,
    toast: undefined,
    ...patch,
  }
}

/** 记录控制器调用的替身：视图用 props 上的方法或 hooks.groups 都记到同一本账。 */
function makeController() {
  const calls = {}
  const record = (name) => (...args) => {
    if (calls[name] === undefined) calls[name] = []
    calls[name].push(args)
    if (name === 'addGroup') return 'g-new'
    return undefined
  }
  const api = { calls }
  for (const name of ['addGroup', 'editGroup', 'editPosition', 'moveGroup', 'requestRemoveGroup', 'cancelRemoveGroup', 'confirmRemoveGroup', 'openGroupScope', 'toggleGroupPanel', 'toggleCollapseAll', 'clearToast']) {
    api[name] = record(name)
  }
  return api
}

/**
 * 调用设置页组件，返回**未展开**的元素树（保留 onClick 之类原始 props）。
 * @param {Array<object>} groups - 组列表。
 * @param {object} [patch] - 额外状态。
 * @param {object} [hooks] - 额外的 props 替身。
 * @returns {{ tree: object, api: object }} 元素树与调用记录。
 */
function settingsTree(groups, patch = {}, hooks = {}) {
  const api = makeController()
  const state = makeState(groups, patch)
  const props = {
    useGroups: (selector) => selector(state),
    hooks: { groups: api },
    ...api,
    ...hooks,
  }
  return { tree: SettingsView(props), api }
}

/** 渲染并展开（场景默认入口）。 */
function page(groups, patch = {}, hooks = {}) {
  resetProbe()
  const { tree, api } = settingsTree(groups, patch, hooks)
  return { rendered: renderPage(tree), api }
}

/** 找组卡片。 */
const groupCards = (node) => byClass(node, 'dshpi-group-card')
/** 找位置行（不带头/正文，用精确 class）。 */
const positionRows = (node) => byClass(node, 'dshpi-position')
/** 按位置名找一行。 */
const rowOf = (node, pointKey) => positionRows(node).find((row) => stringsOf(row).includes(LABELS[pointKey]))
/** 找一组里的 Button。 */
const buttonsOf = (node) => findAll(node, (item) => item.type === 'Button')
/** 按 aria-label 找按钮。 */
const buttonByLabel = (node, label) => buttonsOf(node).find((item) => item.props?.['aria-label'] === label)
/** 找一组里的 Switch。 */
const switchesOf = (node) => findAll(node, (item) => item.type === 'Switch')
/** 找一组里的 textarea。 */
const textareasOf = (node) => findAll(node, (item) => item.type === 'textarea')

// ---------- 零组：居中空状态，整块可点 ----------
{
  const { rendered, api } = page([])
  const emptyStates = byClass(rendered, 'dshpi-empty-state')
  check('零组渲染一块空状态', emptyStates.length === 1, String(emptyStates.length))
  const emptyStrings = stringsOf(emptyStates[0] ?? null).join('|')
  check('空状态文案「还没有注入规则」', emptyStrings.includes('还没有注入规则'), emptyStrings)
  check('空状态文案「＋ 新建组」', emptyStrings.includes('＋ 新建组'), emptyStrings)
  check('空状态整块可点（onClick）', typeof emptyStates[0]?.props?.onClick === 'function')
  check('零组不渲染组卡片', groupCards(rendered).length === 0, String(groupCards(rendered).length))
  check('零组不渲染底部新增按钮', byClass(rendered, 'dshpi-add-group').length === 0)
  emptyStates[0]?.props?.onClick?.()
  check('点空状态会新建组', api.calls.addGroup?.length === 1, JSON.stringify(api.calls.addGroup))
  emptyStates[0]?.props?.onKeyDown?.({ key: 'Enter', preventDefault: () => {} })
  check('空状态支持键盘打开（Enter）', api.calls.addGroup?.length === 2, JSON.stringify(api.calls.addGroup))
}

// ---------- 有组：组卡片 + 8 个位置行 ----------
{
  const group = makeGroup({ positions: { 'user.prefix': { enabled: true, text: '规则正文' } } })
  const { rendered } = page([group])
  const cards = groupCards(rendered)
  check('有组时渲染组卡片', cards.length === 1, String(cards.length))
  const card = cards[0]
  const cardStrings = stringsOf(card).join('|')
  check('组卡片带组名输入框', byClass(card, 'dshpi-group-name').length === 1, String(byClass(card, 'dshpi-group-name').length))
  const nameInput = byClass(card, 'dshpi-group-name')[0]
  check('组名输入框是受控的', nameInput?.props?.value === '工作', JSON.stringify(nameInput?.props?.value))
  check('组卡片带顺序徽章', byClass(card, 'dshpi-order').length === 1)
  check('组卡片有 8 个位置行', positionRows(card).length === 8, String(positionRows(card).length))
  check('8 个位置行标题与注入点表对齐', POINT_KEYS.every((key) => rowOf(card, key) !== undefined), POINT_KEYS.filter((key) => rowOf(card, key) === undefined).join(','))
  check('位置行分成头和正文两块', byClass(card, 'dshpi-position-head').length === 8 && byClass(card, 'dshpi-position-body').length === 1, `${byClass(card, 'dshpi-position-head').length}/${byClass(card, 'dshpi-position-body').length}`)
  check('位置关着时不渲染 textarea', textareasOf(card).length === 1, String(textareasOf(card).length))
  check('开着的位置渲染 textarea 且带正文', textareasOf(card)[0]?.props?.value === '规则正文', JSON.stringify(textareasOf(card)[0]?.props?.value))
  check('开着的位置有 textarea 类名', hasClass(textareasOf(card)[0] ?? {}, 'dshpi-textarea'))
  check('关着的位置标「已关闭」', stringsOf(card).filter((text) => text === '已关闭').length === 7, String(stringsOf(card).filter((text) => text === '已关闭').length))
  // 替换 / 插进标签：system 的 6 个位置必须有（用户前后缀算不算由实现决定，不额外约束条数）。
  const SYSTEM_KEYS = ['system.personaHead', 'system.beforeTools', 'system.afterTools', 'system.middle', 'system.personaTail', 'system.last']
  check('system 的 6 个位置行都带替换 / 插进标签', SYSTEM_KEYS.every((key) => byClass(rowOf(card, key) ?? null, 'dshpi-kind').length === 1), JSON.stringify(SYSTEM_KEYS.filter((key) => byClass(rowOf(card, key) ?? null, 'dshpi-kind').length !== 1)))
  const kindLabels = findAll(card, (item) => hasClass(item, 'dshpi-kind')).map((item) => stringsOf(item).join(''))
  check('替换 / 插进标签文案正确', kindLabels.length >= 6 && kindLabels.every((label) => label === '替换' || label === '插进'), JSON.stringify(kindLabels))
  check('用户前置词行展示 notice', (() => {
    const row = rowOf(card, 'user.prefix')
    return row !== undefined && stringsOf(row).join('|').includes('注入后不会自动清除')
  })())
  // notice 只在位置打开时出现（关着的一行只显示「已关闭」）。
  const suffixRendered = renderPage(settingsTree([makeGroup({ positions: { 'user.prefix': { enabled: true, text: '规则正文' }, 'user.suffix': { enabled: true, text: '' } } })]).tree)
  const suffixRow = rowOf(groupCards(suffixRendered)[0] ?? null, 'user.suffix')
  check('关掉时用户后置词行不显示 notice', !stringsOf(rowOf(card, 'user.suffix') ?? null).join('|').includes('注入后不会自动清除'))
  check('打开后用户后置词行展示 notice', stringsOf(suffixRow ?? null).join('|').includes('注入后不会自动清除'), stringsOf(suffixRow ?? null).join('|').slice(0, 80))
}

// ---------- 组折叠：默认展开，收起后只剩头部一行 ----------
{
  /** 找组卡片上的折叠箭头（原生 button，不是 primitives Button）。 */
  const foldToggleOf = (node) => findAll(node, (item) => hasClass(item, 'dshpi-group-toggle'))[0]
  const group = makeGroup({ positions: { 'user.prefix': { enabled: true, text: '规则正文' } } })
  const { rendered, api } = page([group])
  const card = groupCards(rendered)[0]
  check('组卡片默认展开（data-open=true）', card?.props?.['data-open'] === 'true', String(card?.props?.['data-open']))
  const foldBtn = foldToggleOf(card)
  check('展开时有折叠箭头（aria-expanded=true）', foldBtn !== undefined && foldBtn.props?.['aria-expanded'] === 'true', JSON.stringify(foldBtn?.props?.['aria-expanded']))
  check('展开时渲染 8 个位置行', positionRows(card).length === 8, String(positionRows(card).length))
  foldBtn?.props?.onClick?.()
  check('点折叠箭头调 toggleGroupPanel(id)', api.calls.toggleGroupPanel?.length === 1 && api.calls.toggleGroupPanel[0][0] === 'g1', JSON.stringify(api.calls.toggleGroupPanel))

  // 折叠由快照里的 collapsedGroups 驱动。
  const collapsed = page([group], { collapsedGroups: { g1: true } })
  const collapsedCard = groupCards(collapsed.rendered)[0]
  check('折叠状态驱动渲染（data-open=false）', collapsedCard?.props?.['data-open'] === 'false')
  check('折叠后不渲染位置行', positionRows(collapsedCard).length === 0, String(positionRows(collapsedCard).length))
  check('折叠后头部仍在（组名 / 开关 / 删除都在）', byClass(collapsedCard, 'dshpi-group-name').length === 1 && switchesOf(collapsedCard).length === 1 && buttonByLabel(collapsedCard, '删除这个组') !== undefined)
  const unfoldBtn = foldToggleOf(collapsedCard)
  check('折叠时箭头文案换成「展开」（aria-expanded=false）', unfoldBtn !== undefined && unfoldBtn.props?.['aria-label'] === '展开这个组' && unfoldBtn.props?.['aria-expanded'] === 'false', JSON.stringify(unfoldBtn?.props?.['aria-label']))

  // 两个组互不影响。
  const two = page([makeGroup({ id: 'g1' }), makeGroup({ id: 'g2', name: '第二' })], { collapsedGroups: { g1: true } })
  const twoCards = groupCards(two.rendered)
  check('折叠状态按组各算各的', twoCards[0]?.props?.['data-open'] === 'false' && twoCards[1]?.props?.['data-open'] === 'true', `${twoCards[0]?.props?.['data-open']} / ${twoCards[1]?.props?.['data-open']}`)
}

// ---------- 悬浮栏「全部折叠」 ----------
{
  const barOf = (rendered) => byClass(rendered, 'dshpi-bar')[0]
  const g1 = makeGroup({ id: 'g1' })
  const g2 = makeGroup({ id: 'g2', name: '第二' })
  const { rendered, api } = page([g1, g2])
  const foldAll = buttonByLabel(barOf(rendered), '全部折叠')
  check('有组时悬浮栏有「全部折叠」按钮', foldAll !== undefined)
  foldAll?.props?.onClick?.()
  check('点「全部折叠」调 toggleCollapseAll()', api.calls.toggleCollapseAll?.length === 1, JSON.stringify(api.calls.toggleCollapseAll))

  // 全部折叠后按钮文案换成「全部展开」。
  const allIn = page([g1, g2], { collapsedGroups: { g1: true, g2: true } })
  check('全部折叠后按钮变成「全部展开」', buttonByLabel(barOf(allIn.rendered), '全部展开') !== undefined)

  // 只折叠了一部分时仍是「全部折叠」。
  const partIn = page([g1, g2], { collapsedGroups: { g1: true } })
  check('只折叠一部分时按钮仍是「全部折叠」', buttonByLabel(barOf(partIn.rendered), '全部折叠') !== undefined)

  // 零组时不渲染这个按钮。
  const noneIn = page([])
  check('零组时不渲染「全部折叠」按钮', buttonByLabel(barOf(noneIn.rendered), '全部折叠') === undefined && buttonByLabel(barOf(noneIn.rendered), '全部展开') === undefined)
}

// ---------- 组开关 / 组名 / 位置开关都接到控制器 ----------
{
  const group = makeGroup({ positions: { 'user.prefix': { enabled: true, text: '正文' } } })
  const { rendered, api } = page([group])
  const card = groupCards(rendered)[0]
  const head = byClass(card, 'dshpi-group-head')[0]
  const groupSwitch = switchesOf(head)[0]
  check('组头有启用开关', groupSwitch !== undefined)
  groupSwitch?.props?.onChange?.(false)
  check('点组开关调 editGroup(id, change)', api.calls.editGroup?.length === 1 && api.calls.editGroup[0][0] === 'g1' && typeof api.calls.editGroup[0][1] === 'function', JSON.stringify(api.calls.editGroup?.map((args) => [args[0], typeof args[1]])))
  check('组开关的 change 函数把 enabled 改成 false', api.calls.editGroup?.[0]?.[1]?.({ ...group })?.enabled === false)

  const nameInput = byClass(head, 'dshpi-group-name')[0]
  nameInput?.props?.onChange?.({ target: { value: '新名字' } })
  const renameCall = api.calls.editGroup?.at(-1)
  check('改组名调 editGroup(id, change)', renameCall?.[0] === 'g1' && typeof renameCall?.[1] === 'function', JSON.stringify(api.calls.editGroup?.map((args) => [args[0], typeof args[1]])))
  check('改组名的 change 函数更新 name', renameCall?.[1]?.({ ...group })?.name === '新名字', JSON.stringify(renameCall?.[1]?.({ ...group })?.name))

  const prefixRow = rowOf(card, 'user.prefix')
  const prefixSwitch = switchesOf(byClass(prefixRow, 'dshpi-position-head')[0] ?? prefixRow)[0]
  prefixSwitch?.props?.onChange?.(false)
  const positionCall = api.calls.editPosition?.[0]
  check('点位置开关调 editPosition(groupId, pointKey, patch)', positionCall?.[0] === 'g1' && positionCall?.[1] === 'user.prefix' && positionCall?.[2]?.enabled === false, JSON.stringify(positionCall))

  const textarea = textareasOf(prefixRow)[0]
  textarea?.props?.onChange?.({ target: { value: '改过的正文' } })
  const textCall = api.calls.editPosition?.at(-1)
  check('改位置正文调 editPosition(groupId, pointKey, {text})', textCall?.[0] === 'g1' && textCall?.[1] === 'user.prefix' && textCall?.[2]?.text === '改过的正文', JSON.stringify(textCall))
}

// ---------- 组关闭 / 作用域胶囊 ----------
{
  const offPage = page([makeGroup({ enabled: false })]).rendered
  check('组关闭时显示「已停用」标签', byClass(offPage, 'dshpi-off-tag').length === 1, String(byClass(offPage, 'dshpi-off-tag').length))
  check('「已停用」文案在标签里', stringsOf(byClass(offPage, 'dshpi-off-tag')[0] ?? null).join('|').includes('已停用'), stringsOf(byClass(offPage, 'dshpi-off-tag')[0] ?? null).join('|'))

  const cases = [
    { name: '勾了「全部」', models: { all: true, list: [] }, expect: '全部' },
    { name: '勾了 2 个模型', models: { all: false, list: [FLASH, PRO] }, expect: '已应用 2 个模型' },
    { name: '勾了 1 个模型', models: { all: false, list: [FLASH] }, expect: '已应用 1 个模型' },
    { name: '一个都没勾', models: { all: false, list: [] }, expect: '无应用' },
  ]
  for (const item of cases) {
    const rendered = page([makeGroup({ models: item.models })]).rendered
    const pill = byClass(rendered, 'dshpi-scope')[0]
    const pillStrings = stringsOf(pill ?? null).join('|')
    check(`${item.name}：胶囊显示「${item.expect}」`, pillStrings.includes(item.expect), pillStrings)
  }

  const invalidRendered = page([makeGroup({ models: { all: false, list: ['gone/model', FLASH] } })]).rendered
  const invalidPill = stringsOf(byClass(invalidRendered, 'dshpi-scope')[0] ?? null).join('|')
  check('混了失效模型：只数仍生效的，另标失效数', invalidPill.includes('已应用 1 个模型') && invalidPill.includes('已失效 1'), invalidPill)

  const { rendered, api } = page([makeGroup()])
  const pill = byClass(rendered, 'dshpi-scope')[0]
  pill?.props?.onClick?.()
  check('点作用域胶囊调 openGroupScope(groupId)', api.calls.openGroupScope?.length === 1 && api.calls.openGroupScope[0][0] === 'g1', JSON.stringify(api.calls.openGroupScope))
}

// ---------- 组顺序按钮与删除 ----------
{
  const groups = [
    groupWithText('g1', '第一组', 'user.prefix', '一'),
    groupWithText('g2', '第二组', 'user.prefix', '二'),
    groupWithText('g3', '第三组', 'user.prefix', '三'),
  ]
  const { rendered, api } = page(groups)
  const cards = groupCards(rendered)
  check('三个组渲染成三张卡片', cards.length === 3, String(cards.length))
  const nameOfCard = (card) => byClass(card, 'dshpi-group-name')[0]?.props?.value
  check('组卡片按数组顺序排列', nameOfCard(cards[0]) === '第一组' && nameOfCard(cards[2]) === '第三组', JSON.stringify(cards.map(nameOfCard)))

  const firstHead = byClass(cards[0], 'dshpi-group-head')[0]
  check('第一个组的上移按钮禁用', buttonByLabel(firstHead, '上移这个组')?.props?.disabled === true)
  check('第一个组的下移按钮可用', buttonByLabel(firstHead, '下移这个组')?.props?.disabled !== true)
  const lastHead = byClass(cards[2], 'dshpi-group-head')[0]
  check('最后一个组的下移按钮禁用', buttonByLabel(lastHead, '下移这个组')?.props?.disabled === true)
  check('最后一个组的上移按钮可用', buttonByLabel(lastHead, '上移这个组')?.props?.disabled !== true)

  buttonByLabel(firstHead, '下移这个组')?.props?.onClick?.()
  check('点 ↓ 调 moveGroup(id, +1)', api.calls.moveGroup?.length === 1 && api.calls.moveGroup[0][0] === 'g1' && api.calls.moveGroup[0][1] === 1, JSON.stringify(api.calls.moveGroup))
  buttonByLabel(cards[1] ? byClass(cards[1], 'dshpi-group-head')[0] : null, '上移这个组')?.props?.onClick?.()
  check('点 ↑ 调 moveGroup(id, -1)', api.calls.moveGroup?.length === 2 && api.calls.moveGroup[1][0] === 'g2' && api.calls.moveGroup[1][1] === -1, JSON.stringify(api.calls.moveGroup))

  buttonByLabel(firstHead, '删除这个组')?.props?.onClick?.()
  check('点 ✕ 只请求删除确认（requestRemoveGroup）', api.calls.requestRemoveGroup?.length === 1 && api.calls.requestRemoveGroup[0][0] === 'g1' && api.calls.confirmRemoveGroup === undefined, JSON.stringify(api.calls))
}

// ---------- 删除二次确认 Modal ----------
{
  const group = makeGroup({ id: 'g1', name: '工作' })
  const { rendered, api } = page([group])
  check('没有挂起删除时不渲染确认框', findAll(rendered, (item) => item.type === 'Modal').length === 0)

  const pending = page([group], { pendingRemoveGroupId: 'g1' })
  const modal = findAll(pending.rendered, (item) => item.type === 'Modal')[0]
  check('pendingRemoveGroupId 存在时渲染确认 Modal', modal !== undefined)
  check('确认框标题「删除组」', modal?.props?.title === '删除组', String(modal?.props?.title))
  check('确认框 open', modal?.props?.open === true)
  check('关闭标签是「取消」', modal?.props?.closeLabel === '取消', String(modal?.props?.closeLabel))
  check('确认框说明里带组名', stringsOf(modal?.props?.description ?? []).join('|').includes('工作') || stringsOf(modal?.props?.children ?? []).join('|').includes('工作'), JSON.stringify(modal?.props?.description))

  const footer = render(modal?.props?.footer)
  const footerButtons = findAll(footer, (item) => item.type === 'Button')
  const labels = footerButtons.map((item) => stringsOf(item).join(''))
  check('确认框有两个按钮：取消 / 删除', footerButtons.length === 2 && labels.includes('取消') && labels.includes('删除'), JSON.stringify(labels))
  const cancelButton = footerButtons.find((item) => stringsOf(item).join('') === '取消')
  const deleteButton = footerButtons.find((item) => stringsOf(item).join('') === '删除')
  cancelButton?.props?.onClick?.()
  check('点「取消」调 cancelRemoveGroup', pending.api.calls.cancelRemoveGroup?.length === 1 && pending.api.calls.confirmRemoveGroup === undefined, JSON.stringify(pending.api.calls))
  deleteButton?.props?.onClick?.()
  check('点「删除」调 confirmRemoveGroup', pending.api.calls.confirmRemoveGroup?.length === 1, JSON.stringify(pending.api.calls))
}

// ---------- 组名清空后保存恢复：视图只负责把空名交上去，恢复在控制器 ----------
{
  const { rendered, api } = page([makeGroup({ name: '' })])
  const input = byClass(rendered, 'dshpi-group-name')[0]
  check('空组名可以正常显示（不崩）', input?.props?.value === '', JSON.stringify(input?.props?.value))
  check('空组名的输入框有占位提示', typeof input?.props?.placeholder === 'string' && input.props.placeholder !== '')
  check('对空组名输入时不炸', (() => {
    try {
      input?.props?.onChange?.({ target: { value: '临' } })
      return true
    } catch {
      return false
    }
  })(), JSON.stringify(api.calls.editGroup?.length))
}

// ---------- 底部新增按钮 ----------
{
  const { rendered, api } = page([makeGroup()])
  const addButtons = byClass(rendered, 'dshpi-add-group')
  check('有组时渲染底部新增按钮', addButtons.length === 1, String(addButtons.length))
  check('新增按钮文案「＋ 新增组」', stringsOf(addButtons[0] ?? null).join('') === '＋ 新增组', stringsOf(addButtons[0] ?? null).join(''))
  addButtons[0]?.props?.onClick?.()
  check('点新增按钮调 addGroup()', api.calls.addGroup?.length === 1 && api.calls.addGroup[0].length === 0, JSON.stringify(api.calls.addGroup))
}

// ---------- 拼错模板字段的轻提示 ----------
{
  const bad = page([groupWithText('g1', 'g', 'user.prefix', '看 {{modle}} 和 {{中文}}')]).rendered
  const warn = byClass(bad, 'dshpi-card-warn')
  const warnStrings = stringsOf(warn[0] ?? null).join('|')
  check('拼错的小写字段给提示', warn.length === 1 && warnStrings.includes('{{modle}}') && warnStrings.includes('不是可用的模板字段'), warnStrings)
  check('写中文的 {{}} 当字面文本，不给提示', !warnStrings.includes('{{中文}}'), warnStrings)

  const good = page([groupWithText('g1', 'g', 'user.prefix', '模型 {{model}}，目录 {{cwd}}')]).rendered
  check('用对字段时没有提示', byClass(good, 'dshpi-card-warn').length === 0)
}

// ---------- 顶栏 sticky ----------
{
  const barCss = source.match(/\.dshpi-bar\{[^}]*\}/)?.[0] ?? ''
  check('顶栏样式是悬浮的（position:sticky）', barCss.includes('position:sticky'), barCss)
}

// ---------- 模板字段下拉：开合、不抢焦点、插入回退链 ----------
const triggerOf = (node) => byClass(node, 'dshpi-fieldmenu-trigger')
const popOf = (node) => byClass(node, 'dshpi-fieldmenu-pop')
const itemsOf = (node) => byClass(node, 'dshpi-fieldmenu-item')
/** 点某一项（按字段名）。 */
const itemOf = (node, name) => itemsOf(node).find((item) => item.props?.['aria-label'] === `插入模板字段 ${name}`)

/**
 * 打开顶栏字段菜单，返回展开后的树和记录器。
 * 开合状态存在 stateSlots 里跨渲染保留，所以点一下再渲染一次就能看到面板。
 * @param {Array<object>} groups - 组列表。
 * @param {object} [patch] - 额外状态。
 * @param {object} [hooks] - 额外的 props 替身。
 * @returns {{ rendered: object, api: object }} 展开后的树与调用记录。
 */
function openMenu(groups, patch = {}, hooks = {}) {
  const before = settingsTree(groups, patch, hooks)
  triggerOf(renderPage(before.tree))[0]?.props?.onClick?.()
  const opened = settingsTree(groups, patch, hooks)
  return { rendered: renderPage(opened.tree), api: opened.api }
}

{
  const groups = [groupWithText('g1', '工作', 'user.prefix', '前缀')]
  resetProbe()
  const first = renderPage(settingsTree(groups).tree)
  const trigger = triggerOf(first)[0]
  check('顶栏左侧有「模板字段」下拉触发钮', trigger !== undefined && trigger.type === 'button', String(trigger?.type))
  check('触发钮默认收起', trigger?.props?.['aria-expanded'] === 'false', String(trigger?.props?.['aria-expanded']))
  check('菜单默认关闭（不渲染面板）', popOf(first).length === 0)

  trigger?.props?.onClick?.()
  const openTree = renderPage(settingsTree(groups).tree)
  const openTrigger = triggerOf(openTree)[0]
  check('点触发钮后面板打开', openTrigger?.props?.['aria-expanded'] === 'true')
  const items = itemsOf(openTree)
  check('面板列出全部模板字段', items.length === TEMPLATE_FIELDS.length, String(items.length))
  check(
    '每项带 {{字段}} 徽章、标签与注释',
    TEMPLATE_FIELDS.every((field) => {
      const item = itemOf(openTree, field.name)
      if (item === undefined) return false
      const text = stringsOf(item).join('|')
      return text.includes(`{{${field.name}}}`) && text.includes(field.label) && text.includes(field.note)
    }),
  )

  let triggerPrevented = false
  openTrigger?.props?.onMouseDown?.({ preventDefault: () => { triggerPrevented = true } })
  check(
    '触发钮与菜单项都拦 mousedown（不抢输入框焦点）',
    triggerPrevented === true &&
      items.every((item) => {
        if (typeof item.props?.onMouseDown !== 'function') return false
        let prevented = false
        item.props.onMouseDown({ preventDefault: () => { prevented = true } })
        return prevented
      }),
  )
  check('打开时挂了 document 的 mousedown / keydown 监听', docListeners.has('mousedown') && docListeners.has('keydown'))

  for (const listener of docListeners.get('keydown') ?? []) listener({ key: 'Escape' })
  check('按 Escape 后面板收起来', popOf(renderPage(settingsTree(groups).tree)).length === 0)

  triggerOf(renderPage(settingsTree(groups).tree))[0]?.props?.onClick?.()
  renderPage(settingsTree(groups).tree)
  for (const listener of docListeners.get('mousedown') ?? []) listener({ target: {} })
  check('点面板外面（mousedown）面板收起来', popOf(renderPage(settingsTree(groups).tree)).length === 0)
}

// 焦点在某个位置输入框里：插到那个位置（无真实光标信息时追加到末尾）。
{
  const groups = [
    makeGroup({ id: 'g1', name: '一', positions: { 'user.prefix': { enabled: true, text: 'A' }, 'user.suffix': { enabled: true, text: 'B' } } }),
    groupWithText('g2', '二', 'user.prefix', 'C'),
  ]
  resetProbe()
  const opened = openMenu(groups)
  const prefixRow = rowOf(opened.rendered, 'user.prefix')
  const focusedArea = textareasOf(prefixRow)[0]
  focusedArea?.props?.onFocus?.({ target: focusedArea.__element })
  document.activeElement = focusedArea?.__element
  itemOf(opened.rendered, 'model')?.props?.onClick?.()
  const call = opened.api.calls.editPosition?.[0]
  check('焦点在输入框时插到那个位置', call?.[0] === 'g1' && call?.[1] === 'user.prefix' && call?.[2]?.text === 'A{{model}}', JSON.stringify(call))
}

// 没试过输入框：插到「第一个有非空位置的组的最后一个这类位置」。
{
  const groups = [
    makeGroup({ id: 'g1', name: '一', positions: { 'user.prefix': { enabled: true, text: 'A' }, 'user.suffix': { enabled: true, text: 'B' } } }),
    groupWithText('g2', '二', 'user.prefix', 'C'),
  ]
  resetProbe()
  const opened = openMenu(groups)
  itemOf(opened.rendered, 'model')?.props?.onClick?.()
  const call = opened.api.calls.editPosition?.[0]
  check('没有焦点时插到第一个有内容组的最后一个非空位置', call?.[0] === 'g1' && call?.[1] === 'user.suffix' && call?.[2]?.text === 'B{{model}}', JSON.stringify(call))
}

// 所有位置都空：落到第一组的 user.prefix，并自动打开它。
{
  const groups = [makeGroup({ id: 'g1', name: '一', positions: { 'user.prefix': { enabled: false, text: '' } } })]
  resetProbe()
  const opened = openMenu(groups)
  itemOf(opened.rendered, 'model')?.props?.onClick?.()
  const call = opened.api.calls.editPosition?.[0]
  check('全空时落到第一组 user.prefix 并自动打开', call?.[0] === 'g1' && call?.[1] === 'user.prefix' && call?.[2]?.enabled === true && String(call?.[2]?.text).includes('{{model}}'), JSON.stringify(call))
}

// 零组：一次 addGroup(token) 建好组并填进 user.prefix。
{
  resetProbe()
  const opened = openMenu([])
  itemOf(opened.rendered, 'model')?.props?.onClick?.()
  check('零组时点字段先建组，并把字段一起交出去', opened.api.calls.addGroup?.length === 1 && opened.api.calls.addGroup[0][0] === '{{model}}', JSON.stringify(opened.api.calls.addGroup))
  check('零组建组后不再额外调 editPosition', opened.api.calls.editPosition === undefined)
}

// 老 host 不下发字段表：没有触发钮，页面照常。
{
  resetProbe()
  const tree = renderPage(settingsTree([makeGroup()], { fields: [] }).tree)
  check('host 没给字段表时不渲染下拉（版本错位也不炸）', triggerOf(tree).length === 0)
}

// ---------- Toast ----------
{
  resetProbe()
  const { tree } = settingsTree([makeGroup()], { toast: { text: '已删除组「工作」' } })
  renderPage(tree)
  check('有提示时官方 Toast 拿到文案', primitives.lastToastProps?.text === '已删除组「工作」', String(primitives.lastToastProps?.text))
  check('删除提示没有「撤销」（分组版不带撤销）', primitives.lastToastProps?.actions === undefined || primitives.lastToastProps?.actions?.length === 0, JSON.stringify(primitives.lastToastProps?.actions))
}

{
  resetProbe()
  renderPage(settingsTree([makeGroup()]).tree)
  check('没有提示时不会渲染提示条', primitives.lastToastProps === undefined)
}

// ---------- 作用域弹层 ----------
{
  resetProbe()
  const group = makeGroup({ models: { all: false, list: [FLASH] } })
  const opened = renderPage(settingsTree([group], { openGroupScope: 'g1' }).tree)
  const modal = findAll(opened, (item) => item.type === 'Modal')[0]
  check('openGroupScope 存在时渲染作用域弹层', modal !== undefined)
  check('作用域弹层标题', modal?.props?.title === '模型作用域', String(modal?.props?.title))
  const modalStrings = stringsOf(modal?.props?.children ?? []).join('|')
  check('作用域弹层列出目录里的模型键', CATALOG.providers[0].models.every((model) => modalStrings.includes(`${CATALOG.providers[0].id}/${model.id}`)), modalStrings.slice(0, 120))

  resetProbe()
  const degraded = renderPage(settingsTree([group], { openGroupScope: 'g1', catalog: { ...CATALOG, degraded: true } }).tree)
  const degradedModal = findAll(degraded, (item) => item.type === 'Modal')[0]
  check('目录没拉全时弹层里给一句说明', stringsOf(degradedModal?.props?.children ?? []).join('|').includes('模型目录拉取失败'), stringsOf(degradedModal?.props?.children ?? []).join('|').slice(0, 160))

  // 沿用旧版行为：勾选立即写回组作用域，「完成」/关闭只关弹层。
  resetProbe()
  const liveGroup = makeGroup({ models: { all: false, list: [] } })
  const live = settingsTree([liveGroup], { openGroupScope: 'g1' })
  const boxesOfModal = (modal) => findAll(modal?.props?.children ?? [], (item) => item.type === 'Checkbox')
  const footerButtonsOf = (modal) => findAll(render(modal?.props?.footer), (item) => item.type === 'Button')
  const liveView = renderPage(live.tree)
  const liveModal = findAll(liveView, (item) => item.type === 'Modal')[0]
  boxesOfModal(liveModal).find((box) => box.props?.label === 'deepseek-flash')?.props?.onChange?.()
  const modelCall = live.api.calls.editGroup?.[0]
  const modelPatch = modelCall?.[1]?.({ ...liveGroup })
  check('点某个模型会立即写回组作用域', modelCall?.[0] === 'g1' && JSON.stringify(modelPatch?.models) === JSON.stringify({ all: false, list: [FLASH] }), JSON.stringify(modelPatch?.models))
  boxesOfModal(liveModal)[0]?.props?.onChange?.(true)
  const allCall = live.api.calls.editGroup?.[1]
  const allPatch = allCall?.[1]?.({ ...liveGroup })
  check('点「全部模型」会写完 all 并保留勾选列表', allCall?.[0] === 'g1' && allPatch?.models?.all === true && Array.isArray(allPatch?.models?.list), JSON.stringify(allPatch?.models))
  footerButtonsOf(liveModal).find((button) => stringsOf(button).join('') === '完成')?.props?.onClick?.()
  check('点「完成」关掉弹层', live.api.calls.openGroupScope?.at(-1)?.[0] === undefined, JSON.stringify(live.api.calls.openGroupScope))
  const closingsBefore = live.api.calls.openGroupScope?.length ?? 0
  liveModal?.props?.onClose?.()
  check('弹层关闭动作也接到 openGroupScope(undefined)', (live.api.calls.openGroupScope?.length ?? 0) === closingsBefore + 1 && live.api.calls.openGroupScope?.at(-1)?.[0] === undefined, JSON.stringify(live.api.calls.openGroupScope))
}

console.log(`\n${problems.length === 0 ? '全部通过' : `${problems.length} 项失败`}`)
if (problems.length > 0) {
  console.log('失败项：')
  for (const problem of problems) console.log(`  - ${problem}`)
  process.exitCode = 1
}

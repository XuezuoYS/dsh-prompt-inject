// 轻量渲染探针：把规则卡片渲染成纯文本 / 元素清单，检查卡片的文案与交互接线。
//
// 只 stub React / jsx-runtime / 官方原语：`jsx(type, props)` 遇到函数组件就继续往里渲染
// （`keep` 可以指定某些组件不展开，方便直接读它收到的 props），不需要 DOM，也不需要 DSH 运行时。
//
// 用法：node .agents/checks/verify-card-render.mjs
import { readFile } from 'node:fs/promises'
import { TEMPLATE_FIELDS } from '../../lib/templateFields.js'

const problems = []
const check = (name, ok, detail) => {
  if (!ok) problems.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ---------- 最小 React / jsx 替身 ----------
const react = {
  useState: (initial) => [initial, () => {}],
  useMemo: (factory) => factory(),
  // 真的 ref 在无 DOM 环境里不会被挂上元素，客户端半的「插到光标处」会走「插到最后一条规则」的兜底。
  useRef: (initial) => ({ current: initial }),
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
  return { ...node, props: { ...(node.props ?? {}), children: render(node.props?.children, keep) } }
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

/**
 * 从整页树里切出「规则卡片」那一棵子树（class 含 dshpi-card）。
 * 断言只看卡片，避免把顶部状态栏之类的文案算进来。
 * @param {*} node - 展开后的元素树。
 * @returns {object[]} 卡片子树。
 */
function cardsOf(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) cardsOf(item, out)
    return out
  }
  if (typeof node.props?.className === 'string' && node.props.className.split(' ').includes('dshpi-card')) {
    out.push(node)
    return out
  }
  cardsOf(node.props?.children, out)
  return out
}

/** 官方原语替身：渲染成带名字的元素，props 原样保留。 */
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

/** 传给客户端半的那一份原语替身（会被就地写入 lastToastProps）。 */
const primitives = makePrimitives()

// ---------- 加载客户端半 ----------
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

const registers = []
globalThis.fetch = async () => ({ ok: false, status: 0, json: async () => ({}) })
globalThis.document = { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } }
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

const POINT_KEYS = ['user.prefix', 'user.suffix', 'system.personaHead', 'system.personaTail', 'system.beforeTools', 'system.afterTools', 'system.middle', 'system.last']
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

/**
 * 造一份页面状态。
 * @param {object} slots - 注入点的规则。
 * @param {object} [patch] - 额外覆盖的字段（panels / toast / …）。
 * @returns {object} 状态。
 */
function makeState(slots, patch = {}) {
  return {
    status: 'saved',
    message: '已保存',
    revision: 1,
    slots,
    fields: TEMPLATE_FIELDS,
    catalog: CATALOG,
    panels: {},
    openModelRule: undefined,
    toast: undefined,
    ...patch,
  }
}

/**
 * 调用设置页组件，返回**未展开**的元素树（保留 onClick 之类原始 props）。
 * @param {object} slots - 注入点的规则。
 * @param {object} [patch] - 额外状态。
 * @param {object} [hooks] - 额外的 props 替身（editRules / openModelRule / removeRule / …）。
 * @returns {object} 元素树。
 */
function settingsTree(slots, patch = {}, hooks = {}) {
  return SettingsView({
    useRules: (selector) => selector(makeState(slots, patch)),
    editRules: () => {},
    openModelRule: () => {},
    removeRule: () => {},
    togglePanel: () => {},
    clearToast: () => {},
    ...hooks,
  })
}

/** 造一份空 slots。 */
function baseSlots() {
  const slots = {}
  for (const key of POINT_KEYS) slots[key] = { rules: [] }
  return slots
}

/**
 * 造一份「用户前置词里有若干规则」的 slots。
 * @param {Array<object>} rules - 规则列表。
 * @returns {object} slots。
 */
function slotsWithRules(rules) {
  const slots = baseSlots()
  slots['user.prefix'] = { rules }
  return slots
}

/** 造一条规则。 */
const rule = (id, text, models) => ({ id, enabled: true, text, models })

// ---------- 四种模型作用域状态 ----------
const cases = [
  { name: '勾了「全部」', models: { all: true, list: ['deepseek-account/deepseek-v4-pro'] }, expect: '全部' },
  { name: '勾了 3 个模型', models: { all: false, list: ['deepseek-account/deepseek-flash', 'deepseek-account/deepseek-v4-pro', 'deepseek-account/deepseek-v4-lite'] }, expect: '已应用 3 个模型' },
  { name: '勾了 1 个模型', models: { all: false, list: ['deepseek-account/deepseek-flash'] }, expect: '已应用 1 个模型' },
  { name: '一个都没勾', models: { all: false, list: [] }, expect: '无应用' },
]
for (const item of cases) {
  const cardNode = cardsOf(render(settingsTree(slotsWithRules([rule('r1', '规则正文', item.models)]))))[0]
  const strings = stringsOf(cardNode)
  const joined = strings.join('|')
  check(`${item.name}：卡片只显示「${item.expect}」`, strings.includes(item.expect), joined)
  check(`${item.name}：卡片里不出现任何模型键`, !strings.some((text) => text.includes('deepseek-account/')), joined)
  check(`${item.name}：卡片里不显示规则文本摘要`, !strings.includes('规则正文'), joined)
}

// ---------- 失效模型 ----------
const invalidCard = cardsOf(render(settingsTree(slotsWithRules([rule('r1', 'x', { all: false, list: ['gone/model', 'deepseek-account/deepseek-flash'] })]))))[0]
const invalidStrings = stringsOf(invalidCard).join('|')
check(
  '混了失效模型：结论只数仍生效的，另标失效数',
  invalidStrings.includes('已应用 1 个模型') && invalidStrings.includes('已失效 1'),
  invalidStrings,
)

// ---------- 头部结构 ----------
const cardTree = render(settingsTree(slotsWithRules([rule('r1', 'x', { all: false, list: ['deepseek-account/deepseek-v4-pro', 'deepseek-account/deepseek-v4-lite'] })])))
const classNames = classNamesOf(cardTree)
check('卡片里没有标题节点（dshpi-card-title）', !classNames.some((name) => name.includes('dshpi-card-title')), classNames.join(','))
check('没有竖排移动条（dshpi-move）', !classNames.some((name) => name.includes('dshpi-move')), classNames.join(','))
check(
  '卡片头与按钮组都在',
  classNames.some((name) => name.includes('dshpi-card-head')) && classNames.some((name) => name.includes('dshpi-card-actions')),
)
check('8 个注入点都渲染出来了', classNames.filter((name) => name === 'dshpi-disclosure').length === POINT_KEYS.length, String(classNames.filter((name) => name === 'dshpi-disclosure').length))

const cardNode = cardsOf(cardTree)[0]
const buttons = findAll(cardNode, (node) => node.type === 'Button')
const buttonLabels = buttons.map((node) => node.props['aria-label'])
check(
  '右侧动作都在：上移 / 下移 / 复制 / 删除',
  ['上移这条规则', '下移这条规则', '复制这条规则', '删除这条规则'].every((label) => buttonLabels.includes(label)),
  buttonLabels.join(','),
)
check(
  '上下按钮落在同一个右侧按钮组里',
  findAll(cardNode, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dshpi-card-actions')).some(
    (group) => findAll(group, (node) => node.type === 'Button').length >= 3,
  ),
)
check(
  '上下按钮用图标而不是文字箭头',
  buttons.every((node) => {
    const icon = node.props.icon
    const iconName = icon?.type?.displayName ?? icon?.type?.name ?? icon?.type
    return typeof iconName === 'string' && iconName.startsWith('Icon')
  }),
  buttons.map((node) => String(node.props.icon?.type?.displayName ?? node.props.icon?.type)).join(','),
)
check(
  '唯一一条规则时上移与下移都禁用',
  buttons[0].props.disabled === true && buttons[1].props.disabled === true,
  JSON.stringify({ up: buttons[0].props.disabled, down: buttons[1].props.disabled }),
)

const scopeNode = findAll(cardNode, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dshpi-scope'))[0]
check('模型结论是一枚 button（不再是只读标签）', scopeNode?.type === 'button' && typeof scopeNode?.props?.onClick === 'function', String(scopeNode?.type))
check(
  '模型结论 button 带无障碍名称与提示',
  String(scopeNode?.props?.['aria-label']).includes('模型作用域') && scopeNode?.props?.title === '点击配置模型作用域',
  JSON.stringify({ aria: scopeNode?.props?.['aria-label'], title: scopeNode?.props?.title }),
)
check('卡片里不再有只读的 Tag 标签', findAll(cardNode, (node) => node.type === 'Tag').length === 0)

// ---------- 顶部栏：只报保存状态（不再报「当前解析到的模型」） ----------
const barTree = render(settingsTree(slotsWithRules([rule('r1', 'x', { all: true, list: [] })])))
const barNode = findAll(barTree, (node) => typeof node.props?.className === 'string' && node.props.className === 'dshpi-bar')[0]
const barStrings = stringsOf(barNode).join('|')
check('顶部报保存状态', barStrings.includes('已保存'), barStrings)
check('顶部不再报「当前解析到的模型」', !barStrings.includes('当前解析到') && !barStrings.includes('deepseek-account/'), barStrings)
const barClasses = classNamesOf(barNode).join('|')
check('顶部没有说明文案节点（dshpi-bar-label 已删）', !barClasses.includes('dshpi-bar-label'), barClasses)

// ---------- 模型弹层：目录没拉全时给一句说明；不再挂「当前」标签 ----------
/** 渲染「模型作用域弹层开着」的页面，patch 可覆盖状态。 */
const modalTree = (patch) =>
  render(
    settingsTree(slotsWithRules([rule('r1', 'x', { all: true, list: [] })]), {
      openModelRule: { pointKey: 'user.prefix', ruleId: 'r1' },
      ...patch,
    }),
  )
const noteOf = (tree) => findAll(tree, (node) => typeof node.props?.className === 'string' && node.props.className === 'dshpi-model-note')
const degradedTree = modalTree({ catalog: { ...CATALOG, degraded: true } })
const notes = noteOf(degradedTree)
check(
  '目录没拉全时弹层里说明「已失效」是怎么来的',
  notes.length === 1 && stringsOf(notes[0]).join('').includes('模型目录拉取失败'),
  JSON.stringify(stringsOf(notes[0])),
)
check('目录拉全时没有这句提示', noteOf(modalTree({})).length === 0)
check(
  '弹层里不再有「当前」标签',
  !classNamesOf(degradedTree).join('|').includes('dshpi-current') && findAll(degradedTree, (node) => node.props?.children === '当前').length === 0,
)

// ---------- 点模型结论会开弹层 ----------
const openCalls = []
const scopeTree = settingsTree(slotsWithRules([rule('r1', 'x', { all: true, list: [] })]), {}, {
  openModelRule: (pointKey, ruleId) => openCalls.push({ pointKey, ruleId }),
})
const scopeButton = findAll(render(scopeTree), (node) => typeof node.props?.className === 'string' && node.props.className.includes('dshpi-scope'))[0]
scopeButton?.props?.onClick?.()
check('点模型结论按钮会打开该规则的模型作用域弹层', openCalls.length === 1 && openCalls[0].pointKey === 'user.prefix' && openCalls[0].ruleId === 'r1', JSON.stringify(openCalls))

// ---------- 删除 → 撤销 ----------
const twoRules = slotsWithRules([rule('r1', '第一条', { all: true, list: [] }), rule('r2', '第二条', { all: true, list: [] })])
const removed = []
// 有规则时默认展开，不需要显式 panels。
const deleteTree = settingsTree(twoRules, {}, {
  removeRule: (pointKey, removedRule, at) => removed.push({ pointKey, removedRule, at }),
})
const removeButtons = findAll(render(deleteTree), (node) => node.props?.['aria-label'] === '删除这条规则')
check('两条规则各有一枚删除按钮', removeButtons.length === 2, String(removeButtons.length))
removeButtons[1]?.props?.onClick?.()
check(
  '点删除会带着「规则内容 + 原位置」交给撤销入口',
  removed.length === 1 && removed[0].pointKey === 'user.prefix' && removed[0].removedRule.id === 'r2' && removed[0].at === 1,
  JSON.stringify(removed.map((item) => ({ pointKey: item.pointKey, id: item.removedRule.id, at: item.at }))),
)

const toastTree = settingsTree(baseSlots(), { toast: { text: '已删除 1 条规则', undo: () => {} } })
render(toastTree)
const toastProps = primitives.lastToastProps
const toastActions = toastProps?.actions
check('删除后官方 Toast 拿到提示文案', toastProps?.text === '已删除 1 条规则', String(toastProps?.text))
check(
  '提示里带一个「撤销」动作',
  Array.isArray(toastActions) && toastActions.length === 1 && toastActions[0].label === '撤销' && typeof toastActions[0].onClick === 'function',
  JSON.stringify(toastActions?.map((action) => ({ prefix: action.prefix, label: action.label, clickable: typeof action.onClick === 'function' }))),
)

primitives.lastToastProps = undefined
render(settingsTree(baseSlots()))
check('没有提示时不会渲染提示条', primitives.lastToastProps === undefined)

// ---------- 折叠 ----------
const withRules = slotsWithRules([rule('r1', '一条', { all: true, list: [] })])
const toggles = []
const toggleTree = settingsTree(withRules, {}, { togglePanel: (pointKey, currentOpen) => toggles.push({ pointKey, currentOpen }) })
const heads = findAll(render(toggleTree), (node) => node.props?.['aria-expanded'] !== undefined)
check('8 个注入点都有折叠头', heads.length === 8, String(heads.length))
check('有规则的注入点默认展开', heads.find((node) => node.props['aria-expanded'] === 'true') !== undefined)
const collapsible = heads.filter((node) => node.props['aria-expanded'] === 'true')[0]
collapsible?.props?.onClick?.()
check(
  '点折叠头只把注入点键交给控制器（不再传「当前是否展开」）',
  toggles.length === 1 && toggles[0].pointKey === 'user.prefix' && toggles[0].currentOpen === undefined,
  JSON.stringify(toggles),
)
const closedTree = settingsTree(withRules, { panels: { 'user.prefix': false } })
const closedCards = findAll(render(closedTree), (node) => typeof node.props?.className === 'string' && node.props.className === 'dshpi-card')
check('显式收起后卡片不再渲染', closedCards.length === 0, String(closedCards.length))
const reopened = findAll(render(settingsTree(withRules, { panels: { 'user.prefix': true } })), (node) => typeof node.props?.className === 'string' && node.props.className === 'dshpi-card')
check('显式展开后卡片回来', reopened.length === 1, String(reopened.length))

// ---------- 分组与顺序：system 按在 system 里出现的先后排 ----------
const groupTitles = findAll(render(settingsTree(baseSlots())), (node) => typeof node.props?.className === 'string' && node.props.className.includes('dshpi-group-title')).map((node) => node.props.children)
check('页面分成「用户消息」与「system 段」两组', groupTitles.length === 2 && groupTitles[0] === '用户消息' && String(groupTitles[1]).startsWith('system 段'), JSON.stringify(groupTitles))

const sectionTitles = findAll(render(settingsTree(baseSlots())), (node) => typeof node.props?.className === 'string' && node.props.className === 'dshpi-section-title').map((node) => node.props.children)
const systemOrder = sectionTitles.filter((title) => title.startsWith('system') || ['工具说明之前', '工具说明之后', '结构化输出之前'].includes(title))
check(
  'system 小节顺序 = head → 工具之前 → 工具之后 → 结构化输出之前 → 尾 → 末尾',
  JSON.stringify(systemOrder) === JSON.stringify(['system 头部', '工具说明之前', '工具说明之后', '结构化输出之前', 'system 尾部', 'system 最末尾']),
  JSON.stringify(systemOrder),
)
check('头与尾不再挨着', systemOrder.indexOf('system 头部') === 0 && systemOrder.indexOf('system 尾部') === 4)

const kindPills = findAll(render(settingsTree(baseSlots())), (node) => typeof node.props?.className === 'string' && node.props.className === 'dshpi-kind').map((node) => node.props.children)
check('每个 system 小节标明「替换」还是「插进」', JSON.stringify(kindPills) === JSON.stringify(['替换', '插进', '插进', '插进', '替换', '插进']), JSON.stringify(kindPills))

// ---------- 空规则时的引导 ----------
const emptyStrings = stringsOf(render(settingsTree(baseSlots(), { panels: { 'user.prefix': true } }))).join('|')
check('展开空注入点时给一句引导', emptyStrings.includes('还没有规则'), emptyStrings.slice(0, 160))
const collapsed = stringsOf(render(settingsTree(baseSlots()))).join('|')
check('默认收起时空注入点标「还没有规则」', collapsed.includes('还没有规则'))

// ---------- 模板字段提示条 ----------
/** 找出页面里所有字段徽章。 */
const chipsOf = (node) => findAll(node, (item) => typeof item.props?.className === 'string' && item.props.className === 'dshpi-field-chip')

const chipTree = render(settingsTree(slotsWithRules([rule('r1', '前缀', { all: true, list: [] })])))
const chips = chipsOf(chipTree)
check('展开的注入点里给出全部模板字段徽章', chips.length === TEMPLATE_FIELDS.length, chips.map((chip) => chip.props?.children).join(' | '))
check('徽章上带字段名与短标签', chips.map((chip) => chip.props?.children).join('|') === '{{model}} 模型名|{{provider}} 提供方|{{cwd}} 工作目录', chips.map((chip) => chip.props?.children).join('|'))
const chipStrings = stringsOf(chipTree).join('|')
check('提示条给出字段注释', TEMPLATE_FIELDS.every((field) => chipStrings.includes(`{{${field.name}}} ${field.note}`)), chipStrings.slice(0, 200))
check('徽章可点，且带插入说明', chips.every((chip) => chip.type === 'button' && typeof chip.props?.onClick === 'function' && String(chip.props?.title).includes('插到光标处')))

// 点徽章：没有输入框可参考（无 DOM）时插到该注入点最后一条规则末尾。
const chipEdits = []
const clickTree = render(
  settingsTree(slotsWithRules([rule('r1', '前缀', { all: true, list: [] })]), {}, {
    editRules: (pointKey, change) => chipEdits.push({ pointKey, rules: change([rule('r1', '前缀', { all: true, list: [] })]) }),
  }),
)
chipsOf(clickTree)[0]?.props?.onClick?.()
check(
  '点 {{model}} 徽章把字段插进规则文本',
  chipEdits.length === 1 && chipEdits[0].pointKey === 'user.prefix' && chipEdits[0].rules[0].text === '前缀{{model}}',
  JSON.stringify(chipEdits.map((edit) => edit.rules[0].text)),
)

// 一条规则都没有时点徽章：直接新增一条，内容就是那个字段。
const chipEditsEmpty = []
const emptyTree = render(
  settingsTree(baseSlots(), { panels: { 'user.prefix': true } }, {
    editRules: (pointKey, change) => chipEditsEmpty.push({ pointKey, rules: change([]) }),
  }),
)
chipsOf(emptyTree)[2]?.props?.onClick?.()
check(
  '没有规则时点 {{cwd}} 徽章会新建一条规则',
  chipEditsEmpty.length === 1 && chipEditsEmpty[0].rules.length === 1 && chipEditsEmpty[0].rules[0].text === '{{cwd}}',
  JSON.stringify(chipEditsEmpty.map((edit) => edit.rules.map((item) => item.text))),
)

// 老 host 不下发字段表时：没有徽章，页面照常。
const noFields = render(settingsTree(slotsWithRules([rule('r1', '前缀', { all: true, list: [] })]), { fields: [] }))
check('host 没给字段表时不渲染提示条（版本错位也不炸）', chipsOf(noFields).length === 0)

// ---------- 未知字段的轻提示 ----------
const unknownCard = cardsOf(render(settingsTree(slotsWithRules([rule('r1', '看 {{modle}} 和 {{中文}}', { all: true, list: [] })]))))[0]
const unknownStrings = stringsOf(unknownCard).join('|')
check(
  '拼错的小写字段会在卡片里提示',
  unknownStrings.includes('{{modle}}') && unknownStrings.includes('不是可用的模板字段'),
  unknownStrings,
)
check('写中文的 {{}} 当字面文本，不给提示', !unknownStrings.includes('{{中文}}'), unknownStrings)
const knownCard = cardsOf(render(settingsTree(slotsWithRules([rule('r1', '模型 {{model}}，目录 {{cwd}}', { all: true, list: [] })]))))[0]
check('用对字段时卡片里没有提示', !stringsOf(knownCard).join('|').includes('不是可用的模板字段'))

console.log(`\n${problems.length === 0 ? '全部通过' : `${problems.length} 项失败`}`)
process.exit(problems.length === 0 ? 0 : 1)

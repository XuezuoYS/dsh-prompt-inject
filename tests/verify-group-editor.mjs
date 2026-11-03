// 控制器级回归：真实 `Controller`（经槽位注入面拿到）走一遍分组编辑链路。
//
// 为什么要有这一层：视图只是把点击翻成方法调用，真正的「乐观更新 → debounce → 提交 → 回滚」
// 都在控制器里。这里不渲染页面、不碰 DOM，只按真实链路点方法，然后看快照与 POST 出去的内容。
//
// 覆盖：新增组、改名、清空名后保存时恢复、位置开关 / 正文、上下移、删除二次确认与真删、
// 删光回零组、零组再新建、提交 payload 是 `{ revision, groups }`、409 回滚。
//
// 用法：node tests/verify-group-editor.mjs
import { readFile } from 'node:fs/promises'

const problems = []
const check = (name, ok, detail) => {
  if (!ok) problems.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 注入点键（顺序同服务端表）。 */
const POINT_KEYS = ['user.prefix', 'user.suffix', 'system.personaHead', 'system.beforeTools', 'system.afterTools', 'system.middle', 'system.personaTail', 'system.last']
/** 深比较。 */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
/** 等一拍（debounce 是 500ms）。 */
const waitSave = () => new Promise((resolve) => setTimeout(resolve, 700))
const waitTick = () => new Promise((resolve) => setTimeout(resolve, 30))

/** 造一份完整位置表。 */
function basePositions() {
  const positions = {}
  for (const key of POINT_KEYS) positions[key] = { enabled: false, text: '' }
  return positions
}

// ---------- 最小 React / jsx / 原语替身（控制器不渲染，但 factory 会 require） ----------
const react = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: (factory) => factory(),
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  createElement: () => null,
}
const jsxRuntime = { jsx: (type, props) => ({ type, props: props ?? {} }), jsxs: (type, props) => ({ type, props: props ?? {} }) }
const primitives = new Proxy({}, { get: () => function Stub() {} })

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

// ---------- 假宿主：/state 与 /rules ----------
const posts = []
const stateResponse = { revision: 3, groups: [], fields: [], catalog: { providers: [], degraded: false } }
/** 一旦置真，下一次 POST 回 409，并带上这份「服务端最新值」。 */
let conflictResponse

globalThis.fetch = async (url, init) => {
  if (init?.method === 'POST') {
    const body = JSON.parse(init.body)
    posts.push(body)
    if (conflictResponse !== undefined) {
      const body409 = conflictResponse
      conflictResponse = undefined
      return { ok: false, status: 409, json: async () => body409 }
    }
    return { ok: true, status: 200, json: async () => ({ revision: (body.revision ?? 0) + 1, groups: body.groups }) }
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

const face = registers[0]?.options?.inject?.()
const controller = face?.hooks?.groups
check('从注入面拿到真实控制器', controller !== undefined && typeof controller.getSnapshot === 'function')
if (controller === undefined) {
  console.log('\n1 项失败：拿不到控制器，后面的用例没法跑')
  process.exit(1)
}
const snapshot = () => controller.getSnapshot()
const groupById = (id) => snapshot().groups.find((group) => group.id === id)

// ---------- 首次读取 ----------
await waitTick()
check('首次读取完成：revision 落位', snapshot().revision === 3, String(snapshot().revision))
check('新安装是零组', Array.isArray(snapshot().groups) && snapshot().groups.length === 0, JSON.stringify(snapshot().groups))
check('读配置后状态是「已保存」', snapshot().status === 'saved', String(snapshot().status))
check('lastNames 是控制器内部状态，不进快照', !Object.hasOwn(snapshot(), 'lastNames') && !JSON.stringify(snapshot()).includes('Map'), JSON.stringify(Object.keys(snapshot())))

// ---------- 新增组 ----------
const newId = controller.addGroup()
check('addGroup 返回新组 id', typeof newId === 'string' && newId !== '', String(newId))
check('新增后快照里有一个组', snapshot().groups.length === 1, String(snapshot().groups.length))
const created = snapshot().groups[0]
check('新组用「组 1」这个名字', created.name === '组 1', String(created.name))
check('新组默认启用', created.enabled === true)
check('新组默认对全部模型生效', same(created.models, { all: true, list: [] }), JSON.stringify(created.models))
check('新组带完整 8 个位置键', same(Object.keys(created.positions), POINT_KEYS), JSON.stringify(Object.keys(created.positions)))
check('新组的位置默认关且空', POINT_KEYS.every((key) => same(created.positions[key], { enabled: false, text: '' })), JSON.stringify(created.positions))
check('新组 id 与返回值一致', created.id === newId, `${created.id} / ${newId}`)

await waitSave()
const postAfterAdd = posts.at(-1)
check('新增后排了一次保存', postAfterAdd !== undefined && postAfterAdd.groups?.length === 1, JSON.stringify(postAfterAdd?.groups?.length))
check('提交的 payload 只含 revision 与 groups', postAfterAdd !== undefined && same(Object.keys(postAfterAdd).sort(), ['groups', 'revision']), JSON.stringify(Object.keys(postAfterAdd ?? {})))
check('提交时带上手里的 revision', postAfterAdd?.revision === 3, String(postAfterAdd?.revision))

// ---------- 改名 ----------
controller.editGroup(newId, (group) => ({ ...group, name: '工作' }))
check('改名落到快照', groupById(newId)?.name === '工作', String(groupById(newId)?.name))
await waitSave()
check('改名后排了保存，payload 里是新名字', posts.at(-1)?.groups?.[0]?.name === '工作', String(posts.at(-1)?.groups?.[0]?.name))

// ---------- 清空组名：保存时恢复上一个非空名 ----------
controller.editGroup(newId, (group) => ({ ...group, name: '' }))
check('输入过程中允许空组名', groupById(newId)?.name === '', JSON.stringify(groupById(newId)?.name))
await waitSave()
const payloadAfterClear = posts.at(-1)
check('保存时把空组名恢复成上一个非空名（快照）', groupById(newId)?.name === '工作', JSON.stringify(groupById(newId)?.name))
check('保存时把空组名恢复成上一个非空名（payload）', payloadAfterClear?.groups?.[0]?.name === '工作', JSON.stringify(payloadAfterClear?.groups?.[0]?.name))

// ---------- 位置开关与正文 ----------
controller.editPosition(newId, 'user.prefix', { enabled: true })
check('打开位置落到快照', groupById(newId)?.positions['user.prefix']?.enabled === true, JSON.stringify(groupById(newId)?.positions['user.prefix']))
controller.editPosition(newId, 'user.prefix', { text: '总是用中文回答' })
check('位置正文落到快照', groupById(newId)?.positions['user.prefix']?.text === '总是用中文回答', JSON.stringify(groupById(newId)?.positions['user.prefix']))
check('改一个位置不影响别的组/位置', groupById(newId)?.positions['user.suffix']?.text === '', JSON.stringify(groupById(newId)?.positions['user.suffix']))
await waitSave()
const payloadAfterPosition = posts.at(-1)
check('位置编辑后排了保存，payload 带着位置块', same(payloadAfterPosition?.groups?.[0]?.positions?.['user.prefix'], { enabled: true, text: '总是用中文回答' }), JSON.stringify(payloadAfterPosition?.groups?.[0]?.positions?.['user.prefix']))

// ---------- 新增两组、上下移 ----------
const secondId = controller.addGroup()
const thirdId = controller.addGroup()
check('再新增两组后一共三组', snapshot().groups.length === 3, String(snapshot().groups.length))
check('组名按当前组数递增', groupById(secondId)?.name === '组 2' && groupById(thirdId)?.name === '组 3', JSON.stringify(snapshot().groups.map((group) => group.name)))
controller.moveGroup(thirdId, -1)
check('下移（-1 其实叫上移）后顺序变化', same(snapshot().groups.map((group) => group.id), [newId, thirdId, secondId]), JSON.stringify(snapshot().groups.map((group) => group.id)))
controller.moveGroup(newId, 1)
check('下移后顺序变化', same(snapshot().groups.map((group) => group.id), [thirdId, newId, secondId]), JSON.stringify(snapshot().groups.map((group) => group.id)))
controller.moveGroup(thirdId, -1)
check('首组再上移不动（越界忽略）', same(snapshot().groups.map((group) => group.id), [thirdId, newId, secondId]), JSON.stringify(snapshot().groups.map((group) => group.id)))
await waitSave()

// ---------- debounce：连续编辑只提交一次 ----------
const beforeCoalesce = posts.length
controller.editPosition(thirdId, 'user.suffix', { enabled: true })
controller.editPosition(thirdId, 'user.suffix', { text: 'a' })
controller.editPosition(thirdId, 'user.suffix', { text: 'ab' })
await waitSave()
check('连续编辑合并成一次保存', posts.length === beforeCoalesce + 1, `posts ${beforeCoalesce} → ${posts.length}`)
check('合并后的 payload 是最后的值', posts.at(-1)?.groups?.find((group) => group.id === thirdId)?.positions['user.suffix']?.text === 'ab', JSON.stringify(posts.at(-1)?.groups?.find((group) => group.id === thirdId)?.positions['user.suffix']))

// ---------- 删除：先确认，取消不删，确认才删 ----------
controller.requestRemoveGroup(newId)
check('点删除只挂起确认', snapshot().pendingRemoveGroupId === newId, String(snapshot().pendingRemoveGroupId))
check('挂起确认时组还在', groupById(newId) !== undefined)
controller.cancelRemoveGroup()
check('取消后撤掉确认、组还在', snapshot().pendingRemoveGroupId === undefined && groupById(newId) !== undefined, String(snapshot().pendingRemoveGroupId))

controller.requestRemoveGroup(newId)
controller.confirmRemoveGroup()
check('确认后才真正删掉组', groupById(newId) === undefined, JSON.stringify(snapshot().groups.map((group) => group.id)))
check('删除后确认状态清掉', snapshot().pendingRemoveGroupId === undefined, String(snapshot().pendingRemoveGroupId))
check('删除后给一条提示', snapshot().toast?.text === '已删除组「工作」', JSON.stringify(snapshot().toast?.text))
check('分组版删除没有撤销动作', typeof snapshot().toast?.undo !== 'function', JSON.stringify(Object.keys(snapshot().toast ?? {})))
controller.clearToast()
check('clearToast 收掉提示', snapshot().toast === undefined)

// ---------- 删光回零组，再新建 ----------
for (const group of [...snapshot().groups]) {
  controller.requestRemoveGroup(group.id)
  controller.confirmRemoveGroup()
}
check('删光后回到零组', Array.isArray(snapshot().groups) && snapshot().groups.length === 0, JSON.stringify(snapshot().groups))
check('零组快照不炸、提示还在', snapshot().status !== undefined)
await waitSave()
check('删光后排了保存，payload 是空 groups', same(posts.at(-1)?.groups, []), JSON.stringify(posts.at(-1)?.groups))

const againId = controller.addGroup()
check('零组时再新建一个组', snapshot().groups.length === 1 && typeof againId === 'string', String(snapshot().groups.length))
check('重新从「组 1」开始命名', groupById(againId)?.name === '组 1', String(groupById(againId)?.name))
await waitSave()

// ---------- payload 里每个组的形状 ----------
const lastPayload = posts.at(-1)
const payloadGroup = lastPayload?.groups?.[0]
check('payload 组带 id / name / enabled / models / positions', payloadGroup !== undefined && same(Object.keys(payloadGroup).sort(), ['enabled', 'id', 'models', 'name', 'positions']), JSON.stringify(Object.keys(payloadGroup ?? {})))
check('payload 组的位置表完整', same(Object.keys(payloadGroup?.positions ?? {}), POINT_KEYS), JSON.stringify(Object.keys(payloadGroup?.positions ?? {})))
check('payload 组的作用域形状正确', same(payloadGroup?.models, { all: true, list: [] }), JSON.stringify(payloadGroup?.models))

// ---------- 409：回滚成服务端最新值 ----------
const conflictGroups = [
  {
    id: 'server',
    name: '服务端最新',
    enabled: true,
    models: { all: false, list: ['deepseek-account/deepseek-flash'] },
    positions: { ...basePositions(), 'user.suffix': { enabled: true, text: '服务端写的' } },
  },
]
conflictResponse = { revision: 99, groups: conflictGroups }
controller.editPosition(againId, 'user.prefix', { text: '本地没提交成功' })
await waitSave()
check('409 后 revision 跟服务端走', snapshot().revision === 99, String(snapshot().revision))
check('409 后组回滚成服务端的值', same(snapshot().groups.map((group) => group.id), ['server']) && snapshot().groups[0].positions['user.suffix'].text === '服务端写的', JSON.stringify(snapshot().groups.map((group) => group.id)))
check('409 后状态是失败并带说明', snapshot().status === 'failed' && typeof snapshot().message === 'string' && snapshot().message !== '', JSON.stringify({ status: snapshot().status, message: snapshot().message }))
check('409 的请求体仍是 { revision, groups }', (() => {
  const body = posts.at(-1)
  return same(Object.keys(body ?? {}).sort(), ['groups', 'revision']) && Array.isArray(body?.groups)
})(), JSON.stringify(Object.keys(posts.at(-1) ?? {})))

console.log(`\n${problems.length === 0 ? '全部通过' : `${problems.length} 项失败`}`)
if (problems.length > 0) {
  console.log('失败项：')
  for (const problem of problems) console.log(`  - ${problem}`)
  process.exitCode = 1
}

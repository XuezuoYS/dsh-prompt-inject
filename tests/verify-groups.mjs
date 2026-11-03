// 分组配置的纯逻辑回归：默认形状、v1 迁移、解析顺序与作用域、写前校验。
//
// 只 import 插件自己的模块（不碰官方包），所以任何机器上 `node tests/verify-groups.mjs` 都能跑。
//
// 覆盖四块：
// 1. `groupConfig`：空组就是 `[]`、位置块默认关、默认组形状、v1 → v2 迁移；
// 2. `groupResolver`：组顺序、组/位置开关、模型作用域、空文本与空数组都跳过；
// 3. `configValidation.validateGroups`：零组合法、各类越界逐项报错、未知位置键进 dropped；
// 4. 注入点表本身：8 个键的顺序与数据契约一致（渲染/迁移都按它走）。
//
// 用法：node tests/verify-groups.mjs
import {
  DEFAULT_GROUP_ID,
  DEFAULT_GROUP_NAME,
  defaultGroup,
  emptyGroups,
  emptyPosition,
  emptyPositions,
  groupsFromLegacySlots,
  normalizeGroups,
} from '../lib/groupConfig.js'
import { groupApplies, modelKeyOf, positionParticipates, resolveSlot } from '../lib/groupResolver.js'
import { validateGroups } from '../lib/configValidation.js'
import { INJECT_POINTS } from '../lib/injectPoints.js'

const problems = []
const check = (name, ok, detail) => {
  if (!ok) problems.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 深比较（配置是纯 JSON，JSON 序列化足够）。 */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---------- 0. 注入点表：8 键、顺序固定 ----------
const CONTRACT_KEYS = [
  'user.prefix',
  'user.suffix',
  'system.personaHead',
  'system.beforeTools',
  'system.afterTools',
  'system.middle',
  'system.personaTail',
  'system.last',
]
check('注入点表正好 8 项', INJECT_POINTS.length === 8, String(INJECT_POINTS.length))
check('注入点表的键与契约顺序一致', same(INJECT_POINTS.map((point) => point.key), CONTRACT_KEYS), JSON.stringify(INJECT_POINTS.map((point) => point.key)))

// ---------- 1. 空组与默认形状 ----------
const groupsA = emptyGroups()
const groupsB = emptyGroups()
check('emptyGroups() 返回真正的空数组', Array.isArray(groupsA) && groupsA.length === 0, JSON.stringify(groupsA))
check('emptyGroups() 每次给新数组（不是共享引用）', groupsA !== groupsB)

const position = emptyPosition()
check('位置块默认「关闭 + 空正文」', same(position, { enabled: false, text: '' }), JSON.stringify(position))
check('emptyPosition() 每次给新对象', position !== emptyPosition())

const positions = emptyPositions()
check('位置表正好 8 个键且顺序与注入点表一致', same(Object.keys(positions), CONTRACT_KEYS), JSON.stringify(Object.keys(positions)))
check(
  '位置表每项都是默认位置块',
  CONTRACT_KEYS.every((key) => same(positions[key], { enabled: false, text: '' })),
  JSON.stringify(positions),
)

const fallback = defaultGroup()
check('DEFAULT_GROUP_ID / DEFAULT_GROUP_NAME 是约定的值', DEFAULT_GROUP_ID === 'default' && DEFAULT_GROUP_NAME === '默认组', `${DEFAULT_GROUP_ID} / ${DEFAULT_GROUP_NAME}`)
check('defaultGroup() 的形状', fallback.id === 'default' && fallback.name === '默认组' && fallback.enabled === true && same(fallback.models, { all: true, list: [] }), JSON.stringify(fallback))
check('defaultGroup() 带完整位置表', same(fallback.positions, emptyPositions()), JSON.stringify(fallback.positions))
check('defaultGroup() 每次给新对象', fallback !== defaultGroup() && fallback.positions !== defaultGroup().positions)

// ---------- 2. normalizeGroups：补齐位置、丢掉未知位置、修坏形状 ----------
check('normalizeGroups 对非数组给空数组', same(normalizeGroups(undefined), []) && same(normalizeGroups(null), []) && same(normalizeGroups('x'), []))
check('normalizeGroups 保持空数组', same(normalizeGroups([]), []))

const normalized = normalizeGroups([
  {
    id: 'g1',
    name: '第一组',
    enabled: false,
    models: { all: false, list: ['deepseek-account/deepseek-flash', '', 7] },
    positions: { 'user.prefix': { enabled: true, text: '前缀' }, 'system.persona': { enabled: true, text: '旧键' } },
  },
  null,
])
check('normalizeGroups 跳过非对象项', normalized.length === 1, String(normalized.length))
check('normalizeGroups 补齐 8 个位置键', same(Object.keys(normalized[0]?.positions ?? {}), CONTRACT_KEYS), JSON.stringify(Object.keys(normalized[0]?.positions ?? {})))
check('normalizeGroups 保留已给的位置内容', same(normalized[0]?.positions['user.prefix'], { enabled: true, text: '前缀' }), JSON.stringify(normalized[0]?.positions['user.prefix']))
check('normalizeGroups 丢掉未知位置键', normalized[0]?.positions['system.persona'] === undefined)
check('normalizeGroups 只留有效模型键', same(normalized[0]?.models.list, ['deepseek-account/deepseek-flash']), JSON.stringify(normalized[0]?.models.list))
check('normalizeGroups 保留组开关与组名', normalized[0]?.enabled === false && normalized[0]?.name === '第一组')

const fixedIds = normalizeGroups([{ id: 'dup', name: 'a' }, { id: 'dup', name: 'b' }, { name: 'c' }])
check('normalizeGroups 修掉重复 id', fixedIds[0].id === 'dup' && fixedIds[1].id !== 'dup' && fixedIds[2].id !== 'dup', JSON.stringify(fixedIds.map((group) => group.id)))
check('normalizeGroups 给缺 id 的组补一个非空 id', fixedIds.every((group) => typeof group.id === 'string' && group.id !== ''), JSON.stringify(fixedIds.map((group) => group.id)))

// ---------- 3. v1 迁移：全部文本按顺序合并，位置开关 = 任一启用 ----------
const legacySlots = {
  'user.prefix': {
    rules: [
      { id: 'a', enabled: true, text: '第一条' },
      { id: 'b', enabled: false, text: '第二条' },
      { id: 'c', enabled: true, text: '第三条' },
    ],
  },
  'user.suffix': {
    rules: [
      { id: 'd', enabled: false, text: '只关的' },
      { id: 'e', enabled: false, text: '也是关的' },
    ],
  },
  'system.beforeTools': {
    rules: [
      { id: 'f', enabled: false, text: '位置关着但有字' },
      { id: 'g', enabled: true, text: '' },
      { id: 'h', enabled: true, text: '真正生效' },
    ],
  },
}

const migrated = groupsFromLegacySlots(legacySlots)
check('v1 迁移固定给一个组', Array.isArray(migrated) && migrated.length === 1, String(migrated?.length))
const migratedGroup = migrated[0] ?? {}
check('迁移组用默认 id / 名字 / 开关 / 全部模型', migratedGroup.id === 'default' && migratedGroup.name === '默认组' && migratedGroup.enabled === true && same(migratedGroup.models, { all: true, list: [] }), JSON.stringify({ id: migratedGroup.id, name: migratedGroup.name, enabled: migratedGroup.enabled, models: migratedGroup.models }))
check('迁移后位置表正好 8 个已知键', same(Object.keys(migratedGroup.positions ?? {}), CONTRACT_KEYS), JSON.stringify(Object.keys(migratedGroup.positions ?? {})))
check(
  '同一位置所有正文按规则顺序用空行合并（停用的也保留）',
  migratedGroup.positions?.['user.prefix']?.text === '第一条\n\n第二条\n\n第三条',
  JSON.stringify(migratedGroup.positions?.['user.prefix']),
)
check('位置开关 = 原来至少有一条启用（前面关着也算）', migratedGroup.positions?.['user.prefix']?.enabled === true)
check('原来全关的位置迁移后仍关', migratedGroup.positions?.['user.suffix']?.enabled === false, JSON.stringify(migratedGroup.positions?.['user.suffix']))
check(
  '位置开关看「启用」而不是「有正文」：有字但全关仍关',
  groupsFromLegacySlots({ 'user.suffix': { rules: [{ id: 'x', enabled: false, text: '有字' }] } })[0].positions['user.suffix'].enabled === false,
)
check(
  '空正文不参与合并（不会多出多余空行）',
  migratedGroup.positions?.['system.beforeTools']?.text === '位置关着但有字\n\n真正生效',
  JSON.stringify(migratedGroup.positions?.['system.beforeTools']),
)
check('迁移不读未知位置键', groupsFromLegacySlots({ 'system.persona': { rules: [{ id: 'p', enabled: true, text: '不该出现' }] } })[0].positions['user.prefix'].text === '')

// 空配置也要给一个默认组（更新后现有配置的语义）。
const migratedEmpty = groupsFromLegacySlots(undefined)
check('迁移空配置也给一个默认组', migratedEmpty.length === 1 && migratedEmpty[0].id === 'default')
check('迁移空配置的位置全是「关 + 空」', CONTRACT_KEYS.every((key) => same(migratedEmpty[0].positions[key], { enabled: false, text: '' })))

// 历史键：旧版早期把 persona 头尾合在 `system.persona` 里（head / tail），迁移要拆开。
const legacyPersona = groupsFromLegacySlots({
  'system.persona': {
    head: [{ id: 'h1', enabled: true, text: '旧头 1' }, { id: 'h2', enabled: true, text: '旧头 2' }],
    tail: [{ id: 't1', enabled: false, text: '旧尾' }],
  },
})
const personaPositions = legacyPersona[0].positions
check('历史 system.persona 的 head 合并进 personaHead', personaPositions['system.personaHead'].text === '旧头 1\n\n旧头 2', JSON.stringify(personaPositions['system.personaHead']))
check('历史 system.persona 的 tail 合并进 personaTail', personaPositions['system.personaTail'].text === '旧尾', JSON.stringify(personaPositions['system.personaTail']))
check('历史 system.persona 不再出现在位置表里', personaPositions['system.persona'] === undefined && Object.keys(personaPositions).length === 8)

const legacyCombined = groupsFromLegacySlots({ 'system.persona': { rules: [{ id: 'r', enabled: true, text: '合并键的正文' }] } })
check('历史 system.persona 只有 rules 时落到 personaHead', legacyCombined[0].positions['system.personaHead'].text === '合并键的正文', JSON.stringify(legacyCombined[0].positions['system.personaHead']))

const explicitWins = groupsFromLegacySlots({
  'system.persona': { head: [{ id: 'h', enabled: true, text: '旧' }] },
  'system.personaHead': { rules: [{ id: 'n', enabled: true, text: '新' }] },
})
check('新键已经存在时不覆盖', explicitWins[0].positions['system.personaHead'].text === '新', JSON.stringify(explicitWins[0].positions['system.personaHead']))

// ---------- 4. 解析：组顺序、组/位置开关、模型作用域、空值跳过 ----------
const FLASH = 'deepseek-account/deepseek-flash'
const PRO = 'deepseek-account/deepseek-v4-pro'

/** 造一个组。 */
const makeGroup = (id, text, { enabled = true, models = { all: true, list: [] }, positionEnabled = true } = {}) => ({
  id,
  name: id,
  enabled,
  models,
  positions: { 'user.prefix': { enabled: positionEnabled, text } },
})

check('modelKeyOf 拼出 provider/model', modelKeyOf('deepseek-account', 'deepseek-flash') === FLASH)
check('modelKeyOf 缺一半给 null', modelKeyOf('', 'x') === null && modelKeyOf('x', undefined) === null && modelKeyOf(undefined, undefined) === null)
check('groupApplies：启用 + all 命中', groupApplies({ enabled: true, models: { all: true, list: [] } }, null) === true)
check('groupApplies：组关掉就不命中', groupApplies({ enabled: false, models: { all: true, list: [] } }, FLASH) === false)
check('groupApplies：列表包含当前模型才命中', groupApplies({ enabled: true, models: { all: false, list: [FLASH] } }, FLASH) === true && groupApplies({ enabled: true, models: { all: false, list: [FLASH] } }, PRO) === false)
check('groupApplies：列表为空不命中', groupApplies({ enabled: true, models: { all: false, list: [] } }, FLASH) === false)
check('groupApplies：没有模型键时列表型不命中', groupApplies({ enabled: true, models: { all: false, list: [FLASH] } }, null) === false)
check('positionParticipates：要开着且有正文', positionParticipates({ enabled: true, text: 'x' }) === true && positionParticipates({ enabled: false, text: 'x' }) === false && positionParticipates({ enabled: true, text: '' }) === false && positionParticipates(undefined) === false)

check('空组数组解析为空串', resolveSlot([], 'user.prefix', FLASH) === '')
check('groups 不是数组时给空串', resolveSlot(undefined, 'user.prefix', FLASH) === '' && resolveSlot(null, 'user.prefix', FLASH) === '')
check('未知位置键给空串', resolveSlot([makeGroup('g', 'x')], 'system.persona', FLASH) === '')

const twoGroups = [makeGroup('g1', '组一'), makeGroup('g2', '组二')]
check('两组同一位置按组顺序用空行拼接', resolveSlot(twoGroups, 'user.prefix', FLASH) === '组一\n\n组二', JSON.stringify(resolveSlot(twoGroups, 'user.prefix', FLASH)))
check('交换组顺序，拼接顺序跟着换', resolveSlot([twoGroups[1], twoGroups[0]], 'user.prefix', FLASH) === '组二\n\n组一')
check('组关掉就跳过它', resolveSlot([makeGroup('g1', '组一'), makeGroup('g2', '组二', { enabled: false })], 'user.prefix', FLASH) === '组一')
check('位置关掉就跳过它', resolveSlot([makeGroup('g1', '组一'), makeGroup('g2', '组二', { positionEnabled: false })], 'user.prefix', FLASH) === '组一')
check('空正文就跳过它', resolveSlot([makeGroup('g1', ''), makeGroup('g2', '组二')], 'user.prefix', FLASH) === '组二')
check('没有位置块的组直接跳过', resolveSlot([{ id: 'x', name: 'x', enabled: true, models: { all: true, list: [] }, positions: {} }, makeGroup('g2', '组二')], 'user.prefix', FLASH) === '组二')
check('作用域命中：列表里有当前模型', resolveSlot([makeGroup('g', '专属', { models: { all: false, list: [FLASH] } })], 'user.prefix', FLASH) === '专属')
check('作用域不命中：别的模型', resolveSlot([makeGroup('g', '专属', { models: { all: false, list: [FLASH] } })], 'user.prefix', PRO) === '')
check('作用域不命中：modelKey 为 null', resolveSlot([makeGroup('g', '专属', { models: { all: false, list: [FLASH] } })], 'user.prefix', null) === '')
check('all 组在 modelKey 为 null 时仍生效', resolveSlot([makeGroup('g', '全部')], 'user.prefix', null) === '全部')

// 同一组在不同位置互不影响。
const multiPosition = [
  {
    id: 'g',
    name: 'g',
    enabled: true,
    models: { all: true, list: [] },
    positions: { 'user.prefix': { enabled: true, text: '前置' }, 'user.suffix': { enabled: false, text: '后置关着' } },
  },
]
check('同一组的不同位置各算各的', resolveSlot(multiPosition, 'user.prefix', FLASH) === '前置' && resolveSlot(multiPosition, 'user.suffix', FLASH) === '')

// ---------- 5. validateGroups：合法/非法输入 ----------
const emptyResult = validateGroups([])
check('空数组合法', Array.isArray(emptyResult.issues) && emptyResult.issues.length === 0, JSON.stringify(emptyResult.issues))
check('空数组的 groups 还是空数组（不是 null）', Array.isArray(emptyResult.groups) && emptyResult.groups.length === 0, JSON.stringify(emptyResult.groups))
check('空数组没有 dropped', Array.isArray(emptyResult.dropped) && emptyResult.dropped.length === 0)

check('不是数组时报错', validateGroups('x').issues.length > 0 && validateGroups(undefined).issues.length > 0, JSON.stringify(validateGroups('x').issues))

/** 造一份合法组（可以在 patch 里改出各种非法形状）。 */
const validGroup = (patch = {}) => ({
  id: 'g1',
  name: '第一组',
  enabled: true,
  models: { all: true, list: [] },
  positions: { 'user.prefix': { enabled: true, text: '正文' } },
  ...patch,
})

const validResult = validateGroups([validGroup(), validGroup({ id: 'g2', name: '' })])
check('合法组（含空组名）通过', validResult.issues.length === 0 && validResult.groups?.length === 2, JSON.stringify(validResult.issues))
check('通过时位置表补齐 8 个键', same(Object.keys(validResult.groups?.[0]?.positions ?? {}), CONTRACT_KEYS), JSON.stringify(Object.keys(validResult.groups?.[0]?.positions ?? {})))
check('通过时保留组顺序与字段', validResult.groups?.[0]?.id === 'g1' && validResult.groups?.[0]?.name === '第一组' && validResult.groups?.[1]?.name === '')
check('通过时保留位置正文与开关', same(validResult.groups?.[0]?.positions['user.prefix'], { enabled: true, text: '正文' }), JSON.stringify(validResult.groups?.[0]?.positions['user.prefix']))

const duplicateIds = validateGroups([validGroup(), validGroup()])
check('重复组 id 报错', duplicateIds.issues.length > 0 && duplicateIds.groups === null, JSON.stringify(duplicateIds.issues))

const longName = validateGroups([validGroup({ name: '名'.repeat(60) })])
check('组名 60 个字符合法', longName.issues.length === 0, JSON.stringify(longName.issues))
const tooLongName = validateGroups([validGroup({ name: '名'.repeat(61) })])
check('组名超过 60 个字符报错', tooLongName.issues.length > 0 && tooLongName.groups === null, JSON.stringify(tooLongName.issues))

const maxText = validateGroups([validGroup({ positions: { 'user.prefix': { enabled: true, text: 'x'.repeat(100000) } } })])
check('位置正文 100000 个字符合法', maxText.issues.length === 0, JSON.stringify(maxText.issues))
const tooLongText = validateGroups([validGroup({ positions: { 'user.prefix': { enabled: true, text: 'x'.repeat(100001) } } })])
check('位置正文超过 100000 个字符报错', tooLongText.issues.length > 0 && tooLongText.groups === null, JSON.stringify(tooLongText.issues))

const missingPositions = validateGroups([validGroup({ positions: {} })])
check('缺位置的组自动补齐', missingPositions.issues.length === 0 && same(Object.keys(missingPositions.groups?.[0]?.positions ?? {}), CONTRACT_KEYS), JSON.stringify(missingPositions.issues))
check('补齐的位置默认关且空', same(missingPositions.groups?.[0]?.positions['system.last'], { enabled: false, text: '' }), JSON.stringify(missingPositions.groups?.[0]?.positions['system.last']))

const unknownPosition = validateGroups([validGroup({ positions: { 'user.prefix': { enabled: true, text: '正文' }, bogus: { enabled: true, text: 'x' } } })])
// dropped 里报的是「哪个组的位置表下」哪个键（例如 `groups[0].positions.bogus`），只认末尾那个键。
const droppedHas = (entries, key) => entries.some((entry) => entry === key || entry.endsWith(`.${key}`))
check('未知位置键不报错、进 dropped', unknownPosition.issues.length === 0 && droppedHas(unknownPosition.dropped, 'bogus'), JSON.stringify({ issues: unknownPosition.issues, dropped: unknownPosition.dropped }))
check('未知位置键不会出现在结果位置表里', unknownPosition.groups?.[0]?.positions.bogus === undefined && Object.keys(unknownPosition.groups?.[0]?.positions ?? {}).length === 8)

const badModels = validateGroups([validGroup({ models: { all: 'yes', list: [] } })])
check('models.all 不是布尔报错', badModels.issues.length > 0, JSON.stringify(badModels.issues))
const badList = validateGroups([validGroup({ models: { all: false, list: ['ok', 5] } })])
check('模型列表里有非字符串报错', badList.issues.length > 0, JSON.stringify(badList.issues))
const dedupedModels = validateGroups([validGroup({ models: { all: false, list: ['a/b', 'a/b', 'c/d'] } })])
check('合法模型列表去重', dedupedModels.issues.length === 0 && same(dedupedModels.groups?.[0]?.models.list, ['a/b', 'c/d']), JSON.stringify(dedupedModels.groups?.[0]?.models))
const tooManyModels = validateGroups([validGroup({ models: { all: false, list: Array.from({ length: 501 }, (_, index) => `p/m${index}`) } })])
check('模型键超过 500 个报错', tooManyModels.issues.length > 0, String(tooManyModels.issues.length))

const fiftyGroups = Array.from({ length: 50 }, (_, index) => validGroup({ id: `g${index}` }))
check('50 个组合法', validateGroups(fiftyGroups).issues.length === 0, String(validateGroups(fiftyGroups).issues.length))
const fiftyOneGroups = Array.from({ length: 51 }, (_, index) => validGroup({ id: `g${index}` }))
check('超过 50 个组报错', validateGroups(fiftyOneGroups).issues.length > 0, String(validateGroups(fiftyOneGroups).issues.length))

const badGroupShape = validateGroups([null, { id: '', enabled: 'no', models: null, positions: 'x' }])
check('坏形状的组报错而不是崩', badGroupShape.issues.length > 0 && badGroupShape.groups === null, JSON.stringify(badGroupShape.issues))

console.log(`\n${problems.length === 0 ? '全部通过' : `${problems.length} 项失败`}`)
if (problems.length > 0) {
  console.log('失败项：')
  for (const problem of problems) console.log(`  - ${problem}`)
  process.exitCode = 1
}

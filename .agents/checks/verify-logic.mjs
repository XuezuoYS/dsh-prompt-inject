// 纯逻辑检查：规则解析 / 配置校验 / 还原判据。不需要 DSH 运行时，直接 `node` 跑。
//
// 用法：node .agents/checks/verify-logic.mjs
import { joinRules, modelKeyOf, resolveSlot, ruleApplies } from '../../lib/ruleResolver.js'
import { modelKeyOfAgent } from '../../lib/modelRoute.js'
import { validateSlots } from '../../lib/configValidation.js'
import { emptySlots } from '../../lib/configStore.js'
import { planRestore } from '../../lib/sessionInjector.js'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 造一条规则。 */
const rule = (id, text, models = { all: true, list: [] }, enabled = true) => ({ id, enabled, text, models })

// ---------- 模型键 ----------
check('modelKeyOf 拼 provider/model', modelKeyOf('deepseek-account', 'deepseek-flash') === 'deepseek-account/deepseek-flash')
check('modelKeyOf 缺一个给 null', modelKeyOf(undefined, 'x') === null && modelKeyOf('p', '') === null)

// 没有投影服务（老组合）时 modelRoute 的回退链：requestContext → agent.options。
// 投影优先的完整回归在 verify-model-route.mjs。
const noProjection = { get: () => undefined }
const fakeAgent = {
  options: { provider: 'deepseek-account', model: 'deepseek-flash' },
  session: undefined,
}
check('modelKeyOfAgent 回退到 agent.options', modelKeyOfAgent(noProjection, fakeAgent) === 'deepseek-account/deepseek-flash')
const withContext = {
  options: { provider: 'stale', model: 'stale' },
  session: { requestContext: () => ({ provider: 'pi-ai', model: 'qwen' }) },
}
check('modelKeyOfAgent 优先用会话已解析的路由', modelKeyOfAgent(noProjection, withContext) === 'pi-ai/qwen')

// ---------- 规则是否生效 ----------
check('enabled=false 不生效', ruleApplies(rule('r', 'x', { all: true }, false), 'p/m') === false)
check('空文本不生效', ruleApplies(rule('r', ''), 'p/m') === false)
check('all=true 对所有模型生效', ruleApplies(rule('r', 'x'), 'p/m') === true)
check('all=false 且列表为空不生效', ruleApplies(rule('r', 'x', { all: false, list: [] }), 'p/m') === false)
check('all=false 命中列表生效', ruleApplies(rule('r', 'x', { all: false, list: ['p/m'] }), 'p/m') === true)
check('all=false 未命中列表不生效（失效模型同此）', ruleApplies(rule('r', 'x', { all: false, list: ['p/gone'] }), 'p/m') === false)
check('模型键拿不到时只有 all 生效', ruleApplies(rule('r', 'x', { all: false, list: ['p/m'] }), null) === false)

// ---------- 拼接顺序 ----------
const rules = [rule('a', 'A'), rule('b', 'B', { all: true }, false), rule('c', 'C')]
check('按顺序拼接，关掉的跳过', joinRules(rules, 'p/m') === 'A\n\nC', JSON.stringify(joinRules(rules, 'p/m')))

// ---------- resolveSlot ----------
const slots = emptySlots()
slots['user.prefix'].rules = [rule('p1', '前置'), rule('p2', '只有某模型', { all: false, list: ['other/model'] })]
check('resolveSlot 解析 user.prefix', resolveSlot(slots, 'user.prefix', 'p/m') === '前置')
check('resolveSlot 只对命中模型生效', resolveSlot(slots, 'user.prefix', 'other/model') === '前置\n\n只有某模型')
check('resolveSlot 未知注入点给空串', resolveSlot(slots, 'nope', 'p/m') === '')

// ---------- 配置校验 ----------
const good = emptySlots()
good['user.prefix'].rules = [rule('r1', 'hi')]
const accepted = validateSlots(good)
check('合法配置通过校验', accepted.issues.length === 0 && accepted.slots !== null)

// 未知键：宽容处理 —— 丢掉它、记在 dropped 里，但不整包报错（新旧客户端短暂错位时不能把用户卡死）。
const strayKey = { ...emptySlots(), unknownPoint: { rules: [] } }
const stray = validateSlots(strayKey)
check('未知注入点不再整包报错', stray.issues.length === 0 && stray.slots !== null, JSON.stringify(stray.issues))
check('未知注入点被列进 dropped 并剔除', stray.dropped.includes('unknownPoint') && stray.slots.unknownPoint === undefined, JSON.stringify(stray.dropped))

// 旧形状迁移：`system.persona` 里的 head / tail 要落到两个新注入点上。
const legacy = {
  'user.prefix': { rules: [rule('r1', 'x')] },
  'system.persona': { head: { rules: [rule('h', '旧的头')] }, tail: { rules: [rule('t', '旧的尾')] } },
}
const migrated = validateSlots(legacy)
check(
  '旧形状 system.persona 被迁到 personaHead / personaTail',
  migrated.slots !== null &&
    migrated.slots['system.personaHead'].rules[0]?.text === '旧的头' &&
    migrated.slots['system.personaTail'].rules[0]?.text === '旧的尾' &&
    migrated.slots['system.persona'] === undefined,
  JSON.stringify(migrated.issues),
)
check('迁移是「吸收」而不是「丢弃」：旧键不进 dropped（不给用户看这条噪音）', migrated.dropped.length === 0, JSON.stringify(migrated.dropped))

const legacyBare = validateSlots({ 'system.persona': { rules: [rule('h2', '只有头')] } })
check('旧形状只有 rules 时也当头部迁移', legacyBare.slots?.['system.personaHead'].rules[0]?.text === '只有头', JSON.stringify(legacyBare.issues))

const badRule = emptySlots()
badRule['user.prefix'].rules = [{ id: 'r1', enabled: 'yes', text: 'x', models: { all: true, list: [] } }]
check('enabled 非布尔被拒', validateSlots(badRule).issues.some((item) => item.path.endsWith('.enabled')))

const dupIds = emptySlots()
dupIds['user.prefix'].rules = [rule('same', 'a'), rule('same', 'b')]
check('同注入点内 id 重复被拒', validateSlots(dupIds).issues.some((item) => item.path.endsWith('.id')))

const badModels = emptySlots()
badModels['user.prefix'].rules = [{ id: 'r1', enabled: true, text: 'x', models: { all: true, list: [1] } }]
check('模型列表里混入非字符串被拒', validateSlots(badModels).issues.some((item) => item.path.endsWith('.models.list')))

const wrongType = emptySlots()
wrongType['system.personaHead'] = 42
check('给了错类型被拒', validateSlots(wrongType).issues.some((item) => item.path === 'slots.system.personaHead'))

const partial = validateSlots({ 'user.prefix': { rules: [rule('r1', 'x')] } })
check(
  '只给一个注入点时其余补空、总数不变',
  partial.slots !== null &&
    Object.keys(partial.slots).length === Object.keys(emptySlots()).length &&
    partial.slots['system.personaTail'].rules.length === 0,
  JSON.stringify(partial.issues),
)

// ---------- persona 头与尾是两个独立注入点 ----------
const personaSlots = emptySlots()
personaSlots['system.personaHead'].rules = [rule('h', '我的头')]
personaSlots['system.personaTail'].rules = [rule('t', '我的尾')]
check('解析 system.personaHead', resolveSlot(personaSlots, 'system.personaHead', 'p/m') === '我的头')
check('解析 system.personaTail', resolveSlot(personaSlots, 'system.personaTail', 'p/m') === '我的尾')
personaSlots['system.personaHead'].rules = []
check(
  '头不配时头为空串，尾不受影响',
  resolveSlot(personaSlots, 'system.personaHead', 'p/m') === '' && resolveSlot(personaSlots, 'system.personaTail', 'p/m') === '我的尾',
)

const dedup = emptySlots()
dedup['user.prefix'].rules = [rule('r1', 'x', { all: false, list: ['a/b', 'a/b'] })]
check('模型键去重', validateSlots(dedup).slots?.['user.prefix'].rules[0].models.list.length === 1)

// ---------- 还原判据 ----------
// summarize 出来的形状；注入消息带自己的 turn，用户原文不带 turn。
// 注意 seq 与「位置」是两回事：实测里原文那条的事件号可能比注入那条小、位置却在前，
// 所以下面所有断言都用**位置下标**，并且专门测两种排列。
const injected = (seq, turn) => ({ seq, isInjected: true, isUser: false, isModelSwitch: false, turn, hasContent: true })
const user = (seq) => ({ seq, isInjected: false, isUser: true, isModelSwitch: false, turn: undefined, hasContent: true })
const notice = (seq) => ({ seq, isInjected: false, isUser: false, isModelSwitch: true, turn: undefined, hasContent: true })
const assistant = (seq) => ({ seq, isInjected: false, isUser: false, isModelSwitch: false, turn: undefined, hasContent: true })

/** 把 planRestore 的结果拼成可读字符串，便于断言（区间按下标）。 */
const plan = (nodes, currentTurn) => {
  const result = planRestore(nodes, currentTurn)
  return JSON.stringify({
    restores: result.restores.map((item) => [item.fromIndex, item.toIndex, item.originalIndex]),
    drops: result.drops.map((item) => [item.fromIndex, item.toIndex]),
  })
}

/** 清理区域里不许出现用户原文——这是最要紧的不变量。 */
const noUserDropped = (nodes, currentTurn) => {
  const result = planRestore(nodes, currentTurn)
  const bad = []
  for (const drop of result.drops) {
    for (let index = drop.fromIndex; index <= drop.toIndex; index += 1) if (nodes[index].isUser) bad.push(index)
  }
  return bad.length === 0
}

const isEmpty = JSON.stringify({ restores: [], drops: [] })

check(
  '完整一组（前缀 / 原文 / 后缀）：整段还原成原文，一次替换全吃掉',
  plan([injected(1, 1), user(2), injected(3, 1)], 2) === JSON.stringify({ restores: [[0, 2, 1]], drops: [] }),
  plan([injected(1, 1), user(2), injected(3, 1)], 2),
)
check(
  '实测排列（原文在前、注入在后，且注入事件号更小）：注入照样退场',
  plan([injected(2, 1), user(1), injected(3, 1)], 2) === JSON.stringify({ restores: [[0, 2, 1]], drops: [] }),
  plan([injected(2, 1), user(1), injected(3, 1)], 2),
)
check(
  '实测排列：前缀在原文左、后缀在原文右 —— 一次替换全吃掉',
  plan([injected(3, 1), user(1), injected(2, 1)], 2) === JSON.stringify({ restores: [[0, 2, 1]], drops: [] }),
  plan([injected(3, 1), user(1), injected(2, 1)], 2),
)
check(
  '工具轮之后（前缀 / 原文 / 后缀 / 助手 / 工具结果）：注入全退场，原文留下',
  plan([injected(1, 1), user(2), injected(3, 1), assistant(4), assistant(5)], 2) ===
    JSON.stringify({ restores: [[0, 2, 1]], drops: [] }) &&
    noUserDropped([injected(1, 1), user(2), injected(3, 1), assistant(4), assistant(5)], 2),
  plan([injected(1, 1), user(2), injected(3, 1), assistant(4), assistant(5)], 2),
)
check(
  '实测生产排列（原文在前、后缀在后、号更小）：后缀退场，原文不许被删',
  plan([user(1), injected(2, 1)], 2) === JSON.stringify({ restores: [], drops: [[1, 1]] }) && noUserDropped([user(1), injected(2, 1)], 2),
  plan([user(1), injected(2, 1)], 2),
)
check(
  '实测生产排列 + 助手回复：后缀退场，原文与助手都不动',
  plan([user(1), injected(2, 1), assistant(3), assistant(4)], 2) === JSON.stringify({ restores: [], drops: [[1, 1]] }) &&
    noUserDropped([user(1), injected(2, 1), assistant(3), assistant(4)], 2),
  plan([user(1), injected(2, 1), assistant(3), assistant(4)], 2),
)
check(
  '实测串轮（U1,I1,U3,I2）：两条注入都退场，两条原文都在',
  plan([user(1), injected(2, 1), user(3), injected(4, 2)], 3) === JSON.stringify({ restores: [], drops: [[1, 1], [3, 3]] }) &&
    noUserDropped([user(1), injected(2, 1), user(3), injected(4, 2)], 3),
  plan([user(1), injected(2, 1), user(3), injected(4, 2)], 3),
)
check(
  '实测串轮 V2（I1,U2,I1,I2,U5）：注入全退场，U2 与 U5 都不许被删',
  noUserDropped([injected(1, 1), user(2), injected(3, 1), injected(4, 2), user(5)], 3) &&
    plan([injected(1, 1), user(2), injected(3, 1), injected(4, 2), user(5)], 3) ===
      JSON.stringify({ restores: [[0, 2, 1]], drops: [[3, 3]] }),
  plan([injected(1, 1), user(2), injected(3, 1), injected(4, 2), user(5)], 3),
)
check(
  '相邻两轮：上一轮后缀与这一轮前缀都退场，中间的原文留着',
  noUserDropped([injected(1, 1), user(2), injected(3, 1), injected(4, 2), user(5)], 3) &&
    plan([injected(1, 1), user(2), injected(3, 1), injected(4, 2), user(5)], 3) ===
      JSON.stringify({ restores: [[0, 2, 1]], drops: [[3, 3]] }),
  plan([injected(1, 1), user(2), injected(3, 1), injected(4, 2), user(5)], 3),
)
check(
  '多轮累积：历史注入一条不剩，历史原文一条不少',
  noUserDropped([injected(1, 1), user(2), injected(3, 1), injected(4, 2), user(5), injected(6, 2)], 3) &&
    plan([injected(1, 1), user(2), injected(3, 1), injected(4, 2), user(5), injected(6, 2)], 3) ===
      JSON.stringify({ restores: [[0, 2, 1], [3, 5, 4]], drops: [] }),
  plan([injected(1, 1), user(2), injected(3, 1), injected(4, 2), user(5), injected(6, 2)], 3),
)
check(
  '模型切换提示夹在中间：注入退场，切换提示与原文都不动',
  plan([notice(1), injected(2, 1), user(3)], 2) === JSON.stringify({ restores: [], drops: [[1, 1]] }) &&
    noUserDropped([notice(1), injected(2, 1), user(3)], 2),
  plan([notice(1), injected(2, 1), user(3)], 2),
)
check(
  '前面没有用户原文（原文被压缩遮蔽）：整段注入删掉',
  plan([injected(1, 1), assistant(2)], 2) === JSON.stringify({ restores: [], drops: [[0, 0]] }) && noUserDropped([injected(1, 1), assistant(2)], 2),
  plan([injected(1, 1), assistant(2)], 2),
)
check('属于当前轮的注入不动', plan([injected(1, 5), user(2)], 5) === isEmpty, plan([injected(1, 5), user(2)], 5))
check('没有注入节点时什么都不做', plan([user(1), assistant(2)], 2) === isEmpty, plan([user(1), assistant(2)], 2))
check('模型切换提示不是我们的，不动它', plan([notice(1), assistant(2)], 2) === isEmpty, plan([notice(1), assistant(2)], 2))
check(
  '没有 turn 的老注入（升级前的数据）：只删注入，不碰原文',
  plan([injected(1, undefined), user(2)], 2) === JSON.stringify({ restores: [], drops: [[0, 0]] }) &&
    noUserDropped([injected(1, undefined), user(2)], 2),
  plan([injected(1, undefined), user(2)], 2),
)
const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)

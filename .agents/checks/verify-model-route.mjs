// 模型路由判据的回归：这一轮到底算哪个模型。
//
// 起因（真机 bug）：用户在下拉里把会话从 A 切到 B（同 provider 的另一个模型）后，
// 「配给 A 的规则」还是被打进了 B 的第一次请求。原因是判据用了 `session.requestContext()`——
// 那是**最近一次已提交请求**的路由，而 pre-step / section 求值都发生在这次请求解析之前。
// 现在判据优先读官方的模型选择投影（`modelSelection` 的 pending，与 `dsh-agent` 的
// `installModelSelection` 同一份状态），再退回 requestContext / agent.options。
//
// 这个脚本只 import 插件自己的模块，因此不需要官方包：node .agents/checks/verify-model-route.mjs
import { modelKeyOfAgent, modelKeyOfAssembly, modelKeyOfSelection, modelKeyOfSession } from '../../lib/modelRoute.js'
import { resolveSlot } from '../../lib/ruleResolver.js'
import { registerSystemSections } from '../../lib/systemSections.js'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const FLASH = 'deepseek-account/deepseek-flash'
const REASONER = 'deepseek-account/deepseek-reasoner'

// ---------- 假的官方服务 ----------
const session = { requestContext: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }
const agent = { session, options: { provider: 'deepseek-account', model: 'deepseek-flash' } }

/** 造一个带模型选择投影的 ctx。`state` 为 undefined 表示「没挂投影单元」。 */
const ctxWithProjection = (state) => ({
  get: (name) => (name === 'sessionProjections' ? (state === undefined ? undefined : { stateOf: () => state }) : undefined),
})

// ---------- 1. 投影状态本身 ----------
check('pending 优先：用户刚切换、还没发出去的那个胜出', modelKeyOfSelection({ pending: { provider: 'deepseek-account', model: 'deepseek-reasoner' }, lastUsed: { provider: 'deepseek-account', model: 'deepseek-flash' } }) === REASONER)
check('pending 空则用 lastUsed（切换已经发出去、被 request/header 回收后）', modelKeyOfSelection({ pending: null, lastUsed: { provider: 'deepseek-account', model: 'deepseek-reasoner' } }) === REASONER)
check('两个都空给 null', modelKeyOfSelection({ pending: null, lastUsed: null }) === null)
check('状态缺字段也不炸', modelKeyOfSelection({}) === null && modelKeyOfSelection(undefined) === null)

// ---------- 2. 投影服务缺失时不能更糟 ----------
check('没挂投影单元 → null，交给回退链', modelKeyOfSession(ctxWithProjection(undefined), session) === null)
check('投影单元里没有这个键 → null', modelKeyOfSession({ get: () => ({ stateOf: () => undefined }) }, session) === null)
check('stateOf 抛错 → 吞掉给 null', modelKeyOfSession({ get: () => ({ stateOf: () => { throw new Error('no key') } }) }, session) === null)
check('拿不到 ctx.get → null', modelKeyOfSession(undefined, session) === null && modelKeyOfSession({}, session) === null)

// ---------- 3. 核心回归：pending 必须压过「已提交请求」 ----------
const switched = ctxWithProjection({ pending: { provider: 'deepseek-account', model: 'deepseek-reasoner' }, lastUsed: { provider: 'deepseek-account', model: 'deepseek-flash' } })
check('切换后：算的是新模型，不是 requestContext 里的旧模型', modelKeyOfAgent(switched, agent) === REASONER, String(modelKeyOfAgent(switched, agent)))
check('没有投影时退回 requestContext（改造前行为）', modelKeyOfAgent(ctxWithProjection(undefined), agent) === FLASH)
check('投影空、也没有 requestContext → agent.options', modelKeyOfAgent(ctxWithProjection({ pending: null, lastUsed: null }), { options: { provider: 'deepseek-account', model: 'deepseek-reasoner' } }) === REASONER)
check('什么都没有 → null', modelKeyOfAgent(ctxWithProjection({ pending: null, lastUsed: null }), {}) === null && modelKeyOfAgent(ctxWithProjection(undefined), undefined) === null)

// ---------- 4. 命中判定：A 的规则不能落到 B 身上 ----------
const slots = {
  'user.suffix': { rules: [{ id: 's', enabled: true, text: '【只给 flash】', models: { all: false, list: [FLASH] } }] },
  'user.prefix': { rules: [{ id: 'p', enabled: true, text: '【给所有模型】', models: { all: true, list: [] } }] },
}
check('切到 reasoner：flash 专属规则不生效（原 bug：会生效）', resolveSlot(slots, 'user.suffix', modelKeyOfAgent(switched, agent)) === '')
check('切到 reasoner：all 规则照旧生效', resolveSlot(slots, 'user.prefix', modelKeyOfAgent(switched, agent)) === '【给所有模型】')
check('切回 flash：专属规则生效', resolveSlot(slots, 'user.suffix', modelKeyOfAgent(ctxWithProjection({ pending: { provider: 'deepseek-account', model: 'deepseek-flash' }, lastUsed: null }), agent)) === '【只给 flash】')

// ---------- 5. 组装期：variables 比投影更准 ----------
check('组装结果里带 provider/model 时以它为准', modelKeyOfAssembly(ctxWithProjection({ pending: { provider: 'deepseek-account', model: 'deepseek-flash' }, lastUsed: null }), agent, { variables: { provider: 'deepseek-account', model: 'deepseek-reasoner' } }) === REASONER)
check('组装结果没带变量时退回投影', modelKeyOfAssembly(switched, agent, { variables: {} }) === REASONER)
check('组装结果整个缺失也能退回', modelKeyOfAssembly(switched, agent, undefined) === REASONER)

// ---------- 6. 真接上 systemSections：中间锚点与 persona 改写都按投影走 ----------
/** 造一个能注册 systemSections 的假 ctx，返回它捕获到的段定义与 assemble 监听器。 */
function makeSectionCtx(state) {
  const sections = []
  const handlers = []
  const ctx = {
    get: (name) => (name === 'sessionProjections' ? { stateOf: () => state } : undefined),
    systemPrompt: { section: (definition) => (sections.push(definition), () => {}) },
    effect: (callback) => {
      const value = typeof callback === 'function' ? callback() : undefined
      if (value !== null && typeof value === 'object' && typeof value.next === 'function') {
        let step = value.next()
        while (step.done !== true) step = value.next()
      }
      return () => {}
    },
    on: (name, listener) => (handlers.push({ name, listener }), () => {}),
  }
  return { ctx, sections, handlers }
}

const sectionRules = {
  'system.beforeTools': { rules: [{ id: 'b', enabled: true, text: '【工具说明之前】', models: { all: false, list: [FLASH] } }] },
  'system.personaHead': { rules: [{ id: 'h', enabled: true, text: '【新头】', models: { all: false, list: [FLASH] } }] },
}
const readSectionConfig = async () => ({ revision: 1, slots: sectionRules })

/** 注册一次并等首次读配置落地（refresh 是 fire-and-forget）。 */
async function mountSections(state) {
  const mounted = makeSectionCtx(state)
  registerSystemSections(mounted.ctx, readSectionConfig, () => {})
  await new Promise((resolve) => setTimeout(resolve, 0))
  return mounted
}

const switchedSections = await mountSections({ pending: { provider: 'deepseek-account', model: 'deepseek-reasoner' }, lastUsed: { provider: 'deepseek-account', model: 'deepseek-flash' } })
const beforeTools = switchedSections.sections.find((definition) => definition.name === 'prompt-inject:beforeTools')
check('中间锚点注册上了', beforeTools !== undefined, switchedSections.sections.map((definition) => definition.name).join(', '))
check('中间锚点：切到别的模型后不吐文本（原 bug：会吐 flash 的）', beforeTools.text({ agent }) === '')
check('中间锚点：拿不到模型信息（null）时不吐 flash 专属规则', resolveSlot(sectionRules, 'system.beforeTools', null) === '')
const flashSections = await mountSections({ pending: { provider: 'deepseek-account', model: 'deepseek-flash' }, lastUsed: null })
const flashBeforeTools = flashSections.sections.find((definition) => definition.name === 'prompt-inject:beforeTools')
check('中间锚点：投影指向 flash 时正常吐出', flashBeforeTools.text({ agent }) === '【工具说明之前】', JSON.stringify(flashBeforeTools.text({ agent })))

const assemble = switchedSections.handlers.find((entry) => entry.name === 'system-prompt/assemble')
const officialSections = () => [
  { name: 'deployment:persona-prefix', text: '官方头' },
  { name: 'deployment:persona-suffix', text: '官方尾' },
]
const runAssemble = (variables) =>
  assemble.listener({}, { agent }, async () => ({ sections: officialSections(), variables }))
const switchedAssembly = await runAssemble({ provider: 'deepseek-account', model: 'deepseek-reasoner' })
check('persona 改写：这次组装是别的模型 → 官方头原样保留（原 bug：会被换掉）', switchedAssembly.sections[0].text === '官方头')
const flashAssembly = await runAssemble({ provider: 'deepseek-account', model: 'deepseek-flash' })
check('persona 改写：这次组装是 flash → 换成规则文本', flashAssembly.sections[0].text === '【新头】')
check('persona 改写：没配的段（尾）保持官方默认', flashAssembly.sections[1].text === '官方尾')
const noAgentAssembly = await assemble.listener({}, {}, async () => ({ sections: officialSections(), variables: {} }))
check('没有 agent 的组装（标题/摘要）：只有 all 规则生效，改写不动手', noAgentAssembly.sections[0].text === '官方头')

// ---------- 收尾 ----------
const failed = results.filter((item) => item.ok !== true)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const item of failed) console.log('  - ' + item.name)
  process.exitCode = 1
}

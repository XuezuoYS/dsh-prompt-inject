// 模板字段的纯逻辑回归：白名单、渲染规则、取值兜底。
//
// 只 import 插件自己的模块，不需要官方包：node .agents/checks/verify-template-fields.mjs
import { TEMPLATE_FIELDS, mergeTemplateValues, renderTemplate, templateValuesOfAgent } from '../../lib/templateFields.js'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ---------- 1. 字段表 ----------
check('字段表就是官方那三个，顺序固定', JSON.stringify(TEMPLATE_FIELDS.map((field) => field.name)) === JSON.stringify(['model', 'provider', 'cwd']), JSON.stringify(TEMPLATE_FIELDS.map((field) => field.name)))
check('每个字段都有名字、短标签与注释', TEMPLATE_FIELDS.every((field) => typeof field.name === 'string' && field.label !== '' && field.note !== ''))

// ---------- 2. 渲染：认得的字段就替换 ----------
check('单个字段被替换', renderTemplate('你好 {{model}}', { model: 'deepseek-flash' }) === '你好 deepseek-flash')
check('同一字段出现多次都替换', renderTemplate('{{model}}|{{model}}', { model: 'm' }) === 'm|m')
check('多个字段混排', renderTemplate('{{provider}}/{{model}} @ {{cwd}}', { provider: 'p', model: 'm', cwd: 'D:\\proj' }) === 'p/m @ D:\\proj')
check('没有 {{ 时原样返回（同一个字符串）', renderTemplate('就是一段普通文字', { model: 'm' }) === '就是一段普通文字')
check('空串原样返回', renderTemplate('', { model: 'm' }) === '')
check('非字符串给空串', renderTemplate(undefined, { model: 'm' }) === '' && renderTemplate(123, {}) === '')

// ---------- 3. 渲染：不认识 / 取不到值就原样留着 ----------
check('拼错的名字原样保留', renderTemplate('看 {{modle}}', { model: 'm' }) === '看 {{modle}}')
check('值缺失原样保留', renderTemplate('{{model}}', {}) === '{{model}}' && renderTemplate('{{model}}', { model: undefined }) === '{{model}}')
check('值是空串也算取不到，原样保留', renderTemplate('{{cwd}}', { cwd: '' }) === '{{cwd}}')
check('值不是字符串原样保留', renderTemplate('{{cwd}}', { cwd: 42 }) === '{{cwd}}')
check('取值表整个缺失也不炸', renderTemplate('{{model}}', undefined) === '{{model}}' && renderTemplate('{{model}}', null) === '{{model}}')
check('名字不符合官方规则（大写 / 中文）原样保留', renderTemplate('{{Model}} {{中文}}', { Model: 'x', 中文: 'y' }) === '{{Model}} {{中文}}')
check('只有半个括号就是字面文本', renderTemplate('{{ 没闭合', { model: 'm' }) === '{{ 没闭合')
check('原型链上的名字不算字段', renderTemplate('{{constructor}} {{__proto__}} {{toString}}', {}) === '{{constructor}} {{__proto__}} {{toString}}')
// 官方遇到 {{{model}}} 会判「畸形引用」直接抛错；我们更宽容：里面的 {{model}} 照替换。
check('三层括号按内层替换（官方会抛错，我们宽容）', renderTemplate('{{{model}}}', { model: 'm' }) === '{m}')

// ---------- 4. 取值：agent 兜底 ----------
const agent = { options: { provider: 'deepseek-account', model: 'deepseek-flash' }, session: { header: { cwd: 'D:\\repo' } } }
const fromAgent = templateValuesOfAgent(agent, null)
check('从 agent 上取三个值', fromAgent.provider === 'deepseek-account' && fromAgent.model === 'deepseek-flash' && fromAgent.cwd === 'D:\\repo', JSON.stringify(fromAgent))
check('路由明细优先于 agent 上的旧值', templateValuesOfAgent(agent, { provider: 'deepseek-account', model: 'deepseek-reasoner' }).model === 'deepseek-reasoner')
check('没有 agent 时三个值都是 undefined', JSON.stringify(templateValuesOfAgent(undefined, undefined)) === JSON.stringify({ provider: undefined, model: undefined, cwd: undefined }))

// ---------- 5. 组装期合并：官方 variables 里的非空值压过兜底 ----------
const merged = mergeTemplateValues({ provider: 'p', model: 'old', cwd: 'D:\\repo' }, { model: 'new', cwd: '', provider: undefined })
check('官方变量里的非空值覆盖兜底值', merged.model === 'new' && merged.provider === 'p' && merged.cwd === 'D:\\repo', JSON.stringify(merged))
check('variables 缺失时就是兜底值', JSON.stringify(mergeTemplateValues({ model: 'm' }, undefined)) === JSON.stringify({ model: 'm' }))
check('variables 里的未知名字不会进结果', Object.keys(mergeTemplateValues({}, { something: 'x' })).length === 0)

// ---------- 收尾 ----------
const failed = results.filter((item) => item.ok !== true)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const item of failed) console.log('  - ' + item.name)
  process.exitCode = 1
}

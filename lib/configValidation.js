/**
 * 规则配置的校验：POST /rules 的入参检查，写文件前最后一道门。
 *
 * 校验只认结构，不管业务偏好（比如「没勾模型 = 不生效」不算错误，界面给轻提示而已）。
 *
 * @module dsh-prompt-inject/configValidation
 */

import { INJECT_POINTS } from './injectPoints.js'

/** 一次请求最多接受多少条规则，防止误传大对象。 */
const MAX_RULES_PER_LIST = 200

/** 单条规则文本的上限（字符数）。 */
const MAX_RULE_TEXT_LENGTH = 20000

/** 一个注入点最多接受多少个失效/有效模型键。 */
const MAX_MODEL_KEYS = 500

/**
 * 记一条问题。
 * @param {Array<{ path: string, message: string }>} issues - 问题列表。
 * @param {string} path - 出错位置。
 * @param {string} message - 说明。
 * @returns {void}
 */
function issue(issues, path, message) {
  issues.push({ path, message })
}

/**
 * 校验一个规则列表。
 * @param {unknown} value - 待校验的值。
 * @param {string} path - 位置描述。
 * @param {Array<{ path: string, message: string }>} issues - 问题列表。
 * @returns {Array<object>} 规整后的规则列表；value 形状不对时给空数组。
 */
function validateRuleList(value, path, issues) {
  // 没给这一项 = 空列表（页面只提交改过的那部分也合法）。
  if (value === undefined) return []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issue(issues, path, 'must be an object with a rules array')
    return []
  }
  const rules = value.rules
  if (!Array.isArray(rules)) {
    issue(issues, `${path}.rules`, 'must be an array')
    return []
  }
  if (rules.length > MAX_RULES_PER_LIST) {
    issue(issues, `${path}.rules`, `must not exceed ${MAX_RULES_PER_LIST} entries`)
    return []
  }
  const seen = new Set()
  const result = []
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index]
    const where = `${path}.rules[${index}]`
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      issue(issues, where, 'must be an object')
      continue
    }
    if (typeof rule.id !== 'string' || rule.id === '') {
      issue(issues, `${where}.id`, 'must be a non-empty string')
      continue
    }
    if (seen.has(rule.id)) {
      issue(issues, `${where}.id`, 'must be unique inside one injection point')
      continue
    }
    seen.add(rule.id)
    if (typeof rule.enabled !== 'boolean') {
      issue(issues, `${where}.enabled`, 'must be a boolean')
      continue
    }
    if (typeof rule.text !== 'string') {
      issue(issues, `${where}.text`, 'must be a string')
      continue
    }
    if (rule.text.length > MAX_RULE_TEXT_LENGTH) {
      issue(issues, `${where}.text`, `must not exceed ${MAX_RULE_TEXT_LENGTH} characters`)
      continue
    }
    const models = rule.models
    if (models === null || typeof models !== 'object' || Array.isArray(models)) {
      issue(issues, `${where}.models`, 'must be an object')
      continue
    }
    if (typeof models.all !== 'boolean') {
      issue(issues, `${where}.models.all`, 'must be a boolean')
      continue
    }
    if (!Array.isArray(models.list) || models.list.some((key) => typeof key !== 'string' || key === '')) {
      issue(issues, `${where}.models.list`, 'must be an array of non-empty model keys')
      continue
    }
    if (models.list.length > MAX_MODEL_KEYS) {
      issue(issues, `${where}.models.list`, `must not exceed ${MAX_MODEL_KEYS} entries`)
      continue
    }
    result.push({
      id: rule.id,
      enabled: rule.enabled,
      text: rule.text,
      models: { all: models.all, list: [...new Set(models.list)] },
    })
  }
  return result
}

/**
 * 把「旧形状」的键迁到新键上。
 *
 * 历史：persona 头尾最早是一个注入点 `system.persona`，里面再分 `head` / `tail`；
 * 后来拆成两个独立注入点。老客户端（浏览器里缓存的旧 bundle）还会提交那个键，
 * 于是整包被 422 打回、用户根本存不下去 —— 这里就地迁过来，让新老客户端都能存。
 *
 * @param {object} value - 待校验的 slots（原地改）。
 * @returns {void}
 */
function migrateLegacySlots(value) {
  const legacy = value['system.persona']
  if (legacy === null || typeof legacy !== 'object' || Array.isArray(legacy)) return
  const head = legacy.head ?? legacy.rules
  const tail = legacy.tail
  if (head !== undefined && value['system.personaHead'] === undefined) value['system.personaHead'] = { rules: Array.isArray(head) ? head : head.rules }
  if (tail !== undefined && value['system.personaTail'] === undefined) value['system.personaTail'] = { rules: Array.isArray(tail) ? tail : tail.rules }
  delete value['system.persona']
}

/**
 * 校验整套 slots。
 *
 * 对未知键是**宽容**的：只丢掉它、不整包报错。客户端与服务端的版本可能短暂错位
 * （浏览器里还挂着旧 bundle），因为一个用不上的键让用户「保存失败」是最糟的结果。
 * 真正非法的内容（规则字段、模型列表）仍然逐条报 422。
 *
 * @param {unknown} value - 待校验的 slots。
 * @returns {{ issues: Array<{ path: string, message: string }>, slots: object | null, dropped: string[] }} 结果。
 */
export function validateSlots(value) {
  const issues = []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issue(issues, 'slots', 'must be an object')
    return { issues, slots: null, dropped: [] }
  }
  migrateLegacySlots(value)
  const known = new Set(INJECT_POINTS.map((point) => point.key))
  const dropped = Object.keys(value).filter((key) => !known.has(key))
  const slots = {}
  for (const point of INJECT_POINTS) {
    slots[point.key] = { rules: validateRuleList(value[point.key], `slots.${point.key}`, issues) }
  }
  return { issues, slots: issues.length === 0 ? slots : null, dropped }
}

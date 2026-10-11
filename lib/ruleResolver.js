/**
 * 规则解析：「注入点 + 当前模型」→ 这一次该注入的文本。
 *
 * 判定规则（与 docs/injectScopeAndSetting.md 一致）：
 * - 规则必须 `enabled` 且 `text` 非空；
 * - `models.all` 为真 → 对所有模型生效；
 * - 否则看 `models.list`：空列表 = 不对任何模型生效；不在列表里 = 不生效。
 * 失效模型（已不在目录里）本来就命中不了 list，按「不匹配」处理，不需要额外特判。
 *
 * 这个模块只管「规则与模型键怎么比」，不管「模型键从哪来」——那是 modelRoute.js 的事。
 *
 * @module dsh-prompt-inject/ruleResolver
 */

import { INJECT_POINTS } from './injectPoints.js'

/**
 * 拼出模型键，统一形如 `<provider>/<model>`。
 * @param {string | undefined} provider - provider id。
 * @param {string | undefined} model - model id。
 * @returns {string | null} 模型键；拿不全时给 null。
 */
export function modelKeyOf(provider, model) {
  if (typeof provider !== 'string' || provider === '') return null
  if (typeof model !== 'string' || model === '') return null
  return `${provider}/${model}`
}

/**
 * 判断一条规则这次是否参与拼接。
 * @param {object} rule - 规则。
 * @param {string | null} modelKey - 当前模型键。
 * @returns {boolean} 参与为真。
 */
export function ruleApplies(rule, modelKey) {
  if (rule?.enabled !== true) return false
  if (typeof rule.text !== 'string' || rule.text === '') return false
  if (rule.models?.all === true) return true
  const list = rule.models?.list
  if (!Array.isArray(list) || list.length === 0) return false
  if (modelKey === null) return false
  return list.includes(modelKey)
}

/**
 * 按列表顺序拼接一个规则列表里所有生效的规则。
 * @param {Array<object>} rules - 规则列表。
 * @param {string | null} modelKey - 当前模型键。
 * @returns {string} 拼好的文本；没有生效规则时给空串。
 */
export function joinRules(rules, modelKey) {
  const parts = []
  for (const rule of rules) {
    if (ruleApplies(rule, modelKey)) parts.push(rule.text)
  }
  return parts.join('\n\n')
}

/**
 * 读一个注入点的规则列表。
 * @param {object} slots - 配置里的 slots。
 * @param {string} slotKey - 注入点键。
 * @returns {Array<object>} 规则列表；读不到形状时给空数组。
 */
export function rulesOfSlot(slots, slotKey) {
  const rules = slots?.[slotKey]?.rules
  return Array.isArray(rules) ? rules : []
}

/**
 * 解析一个注入点的文本。
 * @param {object} slots - 配置里的 slots。
 * @param {string} slotKey - 注入点键。
 * @param {string | null} modelKey - 当前模型键。
 * @returns {string} 文本；注入点不存在或没有生效规则时给空串。
 */
export function resolveSlot(slots, slotKey, modelKey) {
  if (!INJECT_POINTS.some((point) => point.key === slotKey)) return ''
  return joinRules(rulesOfSlot(slots, slotKey), modelKey)
}

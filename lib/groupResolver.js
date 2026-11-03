/**
 * 分组解析：「位置 + 当前模型」→ 这一次该注入的文本。
 *
 * 判定规则（与 docs/injectScopeAndSetting.md、docs/userData.md 一致）：
 * - 按组的数组顺序从上到下拼；
 * - 组必须 `enabled`，且作用域命中当前模型（`models.all` 或列表包含模型键）；
 * - 组里对应位置必须 `enabled`，且文本非空；
 * - 命中的文本用空行连接；一条都没命中给空串（等于不注入）。
 *
 * 失效模型（已不在目录里）本来就命中不了 list，按「不匹配」处理，不需要额外特判。
 * 这个模块只管「组与模型键怎么比」，不管「模型键从哪来」——那是 modelRoute.js 的事。
 *
 * @module dsh-prompt-inject/groupResolver
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
 * 判断一个组这次是否参与拼接。
 * @param {object} group - 组。
 * @param {string | null} modelKey - 当前模型键。
 * @returns {boolean} 参与为真。
 */
export function groupApplies(group, modelKey) {
  if (group?.enabled !== true) return false
  if (group.models?.all === true) return true
  const list = group.models?.list
  if (!Array.isArray(list) || list.length === 0) return false
  if (modelKey === null) return false
  return list.includes(modelKey)
}

/**
 * 判断组里的一个位置块这次是否参与拼接。
 * @param {{ enabled?: boolean, text?: string }} block - 位置块。
 * @returns {boolean} 参与为真。
 */
export function positionParticipates(block) {
  return block?.enabled === true && typeof block.text === 'string' && block.text !== ''
}

/**
 * 解析一个位置的文本：按组顺序收集所有生效的位置块。
 * @param {Array<object>} groups - 配置里的组列表（可以为空）。
 * @param {string} slotKey - 注入点键。
 * @param {string | null} modelKey - 当前模型键。
 * @returns {string} 文本；没有生效内容时给空串。
 */
export function resolveSlot(groups, slotKey, modelKey) {
  if (!INJECT_POINTS.some((point) => point.key === slotKey)) return ''
  if (!Array.isArray(groups)) return ''
  const parts = []
  for (const group of groups) {
    if (!groupApplies(group, modelKey)) continue
    const block = group?.positions?.[slotKey]
    if (!positionParticipates(block)) continue
    parts.push(block.text)
  }
  return parts.join('\n\n')
}

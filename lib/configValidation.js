/**
 * 分组配置的校验：POST /rules 的入参检查，写文件前最后一道门。
 *
 * 校验只认结构，不管业务偏好（比如「组关闭 = 不生效」不算错误，界面给轻提示而已）。
 * `groups: []` 是合法状态——新安装、或者用户把组全删了，就是不注入。
 *
 * @module dsh-prompt-inject/configValidation
 */

import { INJECT_POINTS } from './injectPoints.js'
import { emptyPosition, emptyPositions } from './groupConfig.js'

/** 一次最多接受多少个组，防止误传大对象。 */
export const MAX_GROUPS = 50

/** 组 id 的长度上限。 */
export const MAX_GROUP_ID_LENGTH = 128

/** 组名的长度上限（允许空串）。 */
export const MAX_GROUP_NAME_LENGTH = 60

/** 单个位置块正文的上限（字符数）。 */
export const MAX_POSITION_TEXT_LENGTH = 100000

/** 一个组最多接受多少个失效/有效模型键。 */
export const MAX_MODEL_KEYS = 500

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
 * 校验一个组的模型作用域。
 * @param {unknown} value - 待校验的值。
 * @param {string} path - 位置描述。
 * @param {Array<{ path: string, message: string }>} issues - 问题列表。
 * @returns {{ all: boolean, list: string[] } | null} 规整后的作用域；不合法给 null。
 */
function validateModels(value, path, issues) {
  const before = issues.length
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issue(issues, path, 'must be an object with all and list')
    return null
  }
  if (typeof value.all !== 'boolean') issue(issues, `${path}.all`, 'must be a boolean')
  if (!Array.isArray(value.list) || value.list.some((key) => typeof key !== 'string' || key === '')) {
    issue(issues, `${path}.list`, 'must be an array of non-empty model keys')
    return null
  }
  if (value.list.length > MAX_MODEL_KEYS) {
    issue(issues, `${path}.list`, `must not exceed ${MAX_MODEL_KEYS} entries`)
    return null
  }
  if (issues.length > before) return null
  return { all: value.all, list: [...new Set(value.list)] }
}

/**
 * 校验一个组的位置表。
 *
 * 没给的位置补默认块；未知的注入点键不报错，记进 `dropped`（兼容版本错位时多传的键）。
 *
 * @param {unknown} value - 待校验的值。
 * @param {string} path - 位置描述。
 * @param {Array<{ path: string, message: string }>} issues - 问题列表。
 * @param {string[]} dropped - 被忽略的未知位置键。
 * @returns {Record<string, { enabled: boolean, text: string }>} 规整后的位置表。
 */
function validatePositions(value, path, issues, dropped) {
  if (value === undefined) return emptyPositions()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issue(issues, path, 'must be an object keyed by injection point')
    return emptyPositions()
  }
  const known = new Set(INJECT_POINTS.map((point) => point.key))
  for (const key of Object.keys(value)) {
    if (!known.has(key)) dropped.push(`${path}.${key}`)
  }
  const positions = {}
  for (const point of INJECT_POINTS) {
    const block = value[point.key]
    if (block === undefined) {
      positions[point.key] = emptyPosition()
      continue
    }
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
      issue(issues, `${path}.${point.key}`, 'must be an object with enabled and text')
      positions[point.key] = emptyPosition()
      continue
    }
    if (typeof block.enabled !== 'boolean') {
      issue(issues, `${path}.${point.key}.enabled`, 'must be a boolean')
    }
    if (typeof block.text !== 'string') {
      issue(issues, `${path}.${point.key}.text`, 'must be a string')
    } else if (block.text.length > MAX_POSITION_TEXT_LENGTH) {
      issue(issues, `${path}.${point.key}.text`, `must not exceed ${MAX_POSITION_TEXT_LENGTH} characters`)
    }
    positions[point.key] = {
      enabled: block.enabled === true,
      text: typeof block.text === 'string' ? block.text : '',
    }
  }
  return positions
}

/**
 * 校验一个组。
 * @param {unknown} value - 待校验的值。
 * @param {number} index - 在数组里的下标（只用于报错路径）。
 * @param {Array<{ path: string, message: string }>} issues - 问题列表。
 * @param {string[]} dropped - 被忽略的未知位置键。
 * @param {Set<string>} seenIds - 已经出现过的组 id。
 * @returns {object | null} 规整后的组；不合法给 null。
 */
function validateGroup(value, index, issues, dropped, seenIds) {
  const path = `groups[${index}]`
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issue(issues, path, 'must be an object')
    return null
  }
  const before = issues.length
  let id = `group-${index + 1}`
  if (typeof value.id !== 'string' || value.id === '') {
    issue(issues, `${path}.id`, 'must be a non-empty string')
  } else if (value.id.length > MAX_GROUP_ID_LENGTH) {
    issue(issues, `${path}.id`, `must not exceed ${MAX_GROUP_ID_LENGTH} characters`)
  } else if (seenIds.has(value.id)) {
    issue(issues, `${path}.id`, 'must be unique inside groups')
  } else {
    id = value.id
    seenIds.add(id)
  }
  if (typeof value.name !== 'string') {
    issue(issues, `${path}.name`, 'must be a string')
  } else if (value.name.length > MAX_GROUP_NAME_LENGTH) {
    issue(issues, `${path}.name`, `must not exceed ${MAX_GROUP_NAME_LENGTH} characters`)
  }
  if (typeof value.enabled !== 'boolean') issue(issues, `${path}.enabled`, 'must be a boolean')
  const models = validateModels(value.models, `${path}.models`, issues)
  const positions = validatePositions(value.positions, `${path}.positions`, issues, dropped)
  if (issues.length > before) return null
  return {
    id,
    name: typeof value.name === 'string' ? value.name : `组 ${index + 1}`,
    enabled: value.enabled === true,
    models,
    positions,
  }
}

/**
 * 校验整套 groups。
 *
 * 对未知位置键是**宽容**的：只丢掉它、不整包报错。客户端与服务端的版本可能短暂错位
 * （浏览器里还挂着旧 bundle），因为一个用不上的键让用户「保存失败」是最糟的结果。
 * 真正非法的内容（组字段、模型列表）仍然逐条报 422。
 *
 * @param {unknown} value - 待校验的 groups。
 * @returns {{ issues: Array<{ path: string, message: string }>, groups: Array<object> | null, dropped: string[] }} 结果。
 */
export function validateGroups(value) {
  const issues = []
  if (!Array.isArray(value)) {
    issue(issues, 'groups', 'must be an array of groups')
    return { issues, groups: null, dropped: [] }
  }
  if (value.length > MAX_GROUPS) {
    issue(issues, 'groups', `must not exceed ${MAX_GROUPS} entries`)
    return { issues, groups: null, dropped: [] }
  }
  const dropped = []
  const seenIds = new Set()
  const groups = []
  for (let index = 0; index < value.length; index += 1) {
    const group = validateGroup(value[index], index, issues, dropped, seenIds)
    if (group !== null) groups.push(group)
  }
  return {
    issues,
    groups: issues.length === 0 ? groups : null,
    dropped: [...new Set(dropped)],
  }
}

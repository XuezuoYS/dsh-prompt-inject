/**
 * 分组配置的纯工具：默认组、空位置块、读取规整、v1 → v2 迁移。
 *
 * 这里不碰文件、不碰宿主：`configStore` 用它规整磁盘内容，`configValidation` 用它补默认值，
 * 测试也可以直接 import。v2 的 `groups` 允许是空数组——新安装、或者用户把组全删了，
 * 就是「零组状态」，此时哪里都不注入。
 *
 * @module dsh-prompt-inject/groupConfig
 */

import { INJECT_POINTS } from './injectPoints.js'

/** 迁移时生成的默认组 id。 */
export const DEFAULT_GROUP_ID = 'default'

/** 迁移时生成的默认组名。 */
export const DEFAULT_GROUP_NAME = '默认组'

/**
 * 造一个位置块：默认关闭、正文为空。
 * @returns {{ enabled: boolean, text: string }} 位置块。
 */
export function emptyPosition() {
  return { enabled: false, text: '' }
}

/**
 * 造一份完整的位置表：8 个已知注入点各一个默认块。
 * @returns {Record<string, { enabled: boolean, text: string }>} 位置表。
 */
export function emptyPositions() {
  const positions = {}
  for (const point of INJECT_POINTS) positions[point.key] = emptyPosition()
  return positions
}

/**
 * 造一个空的默认组（迁移用；新建组的名字由界面决定）。
 * @returns {object} 默认组。
 */
export function defaultGroup() {
  return {
    id: DEFAULT_GROUP_ID,
    name: DEFAULT_GROUP_NAME,
    enabled: true,
    models: { all: true, list: [] },
    positions: emptyPositions(),
  }
}

/**
 * 空配置的组列表：零组。
 * @returns {Array<object>} 空数组。
 */
export function emptyGroups() {
  return []
}

/**
 * 把旧版 `system.persona`（head / tail 二合一）拆成两个独立注入点。
 *
 * 老客户端可能还提交这个键；v1 文件也可能带着它。先迁到新键，再按位置合并规则。
 *
 * @param {object | undefined} slots - 旧版 slots。
 * @returns {object} 拆好键的新对象（不改入参）。
 */
function splitLegacyPersona(slots) {
  const next = { ...(slots ?? {}) }
  const legacy = next['system.persona']
  if (legacy === null || typeof legacy !== 'object' || Array.isArray(legacy)) return next
  const head = legacy.head ?? legacy.rules
  const tail = legacy.tail
  if (head !== undefined && next['system.personaHead'] === undefined) {
    next['system.personaHead'] = Array.isArray(head) ? { rules: head } : head
  }
  if (tail !== undefined && next['system.personaTail'] === undefined) {
    next['system.personaTail'] = Array.isArray(tail) ? { rules: tail } : tail
  }
  delete next['system.persona']
  return next
}

/**
 * 把 v1 的「注入点 → 规则列表」迁移成 v2 的「一个默认组」。
 *
 * 迁移规则：
 * - 同一位置下所有规则的正文按列表顺序用空行连接，一条都不丢；
 * - 位置开关 = 原来至少有一条规则启用（原来全关的位置迁移后仍关）；
 * - 每条旧规则自己的模型作用域不保留，默认组按「全部模型」处理；
 * - 只要文件是 v1（哪怕规则全空），就生成一个默认组，因为这是「更新后现有的配置」。
 *
 * @param {object | undefined} slots - v1 的 slots。
 * @returns {Array<object>} 迁移后的 groups（固定一个默认组）。
 */
export function groupsFromLegacySlots(slots) {
  const source = splitLegacyPersona(slots)
  const positions = {}
  for (const point of INJECT_POINTS) {
    const rules = source?.[point.key]?.rules
    const list = Array.isArray(rules) ? rules : []
    const texts = []
    let enabled = false
    for (const rule of list) {
      if (rule?.enabled === true) enabled = true
      if (typeof rule?.text === 'string' && rule.text !== '') texts.push(rule.text)
    }
    positions[point.key] = { enabled, text: texts.join('\n\n') }
  }
  return [
    {
      id: DEFAULT_GROUP_ID,
      name: DEFAULT_GROUP_NAME,
      enabled: true,
      models: { all: true, list: [] },
      positions,
    },
  ]
}

/**
 * 规整磁盘上的 groups：补齐缺失位置、丢掉未知位置、修掉明显坏形状。
 *
 * 这里只保证「形状能安全解析」，不负责业务校验；真正写文件前还有 `configValidation` 那一层。
 *
 * @param {unknown} groups - 任意 groups 值。
 * @returns {Array<object>} 规整后的 groups（空数组保持空）。
 */
export function normalizeGroups(groups) {
  if (!Array.isArray(groups)) return []
  const result = []
  const seen = new Set()
  for (let index = 0; index < groups.length; index += 1) {
    const source = groups[index]
    if (source === null || typeof source !== 'object' || Array.isArray(source)) continue
    let id = typeof source.id === 'string' && source.id !== '' ? source.id : `group-${index + 1}`
    if (seen.has(id)) id = `${id}-${index + 1}`
    while (seen.has(id)) id = `${id}-x`
    seen.add(id)
    const positions = {}
    const sourcePositions = source.positions !== null && typeof source.positions === 'object' && !Array.isArray(source.positions) ? source.positions : {}
    for (const point of INJECT_POINTS) {
      const block = sourcePositions[point.key]
      positions[point.key] = {
        enabled: block?.enabled === true,
        text: typeof block?.text === 'string' ? block.text : '',
      }
    }
    const models = source.models !== null && typeof source.models === 'object' && !Array.isArray(source.models) ? source.models : {}
    result.push({
      id,
      name: typeof source.name === 'string' ? source.name : `组 ${index + 1}`,
      enabled: source.enabled !== false,
      models: {
        all: models.all === true,
        list: Array.isArray(models.list) ? models.list.filter((key) => typeof key === 'string' && key !== '') : [],
      },
      positions,
    })
  }
  return result
}

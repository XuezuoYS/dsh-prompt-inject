/**
 * 用户前后缀的注入与还原（`agent/pre-step`）。
 *
 * 一轮的动作：先把上一轮留下的注入还原成用户原文，再把「前缀 / 原文 / 后缀」三条消息
 * 交给这一步落库。工具循环的续跑没有用户消息，什么都不做，本轮注入自然保持在历史里。
 *
 * 还原只按 surface 上的节点判断（不依赖内存状态），进程重启后也能自愈。
 * 每一条注入消息都带自己的 `turn`，所以「只还原属于更早轮次的那一份」是确定性的。
 *
 * @module dsh-prompt-inject/sessionInjector
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolveSlot } from './ruleResolver.js'
import { renderTemplate, templateValuesOfAgent } from './templateFields.js'

/** 注入消息的 source.kind（不能是 `user`，否则客户端会画成用户气泡）。 */
export const INJECT_SOURCE_KIND = 'prompt-inject'

/** 模型切换提示的文案前缀：官方 `dsh-agent` 的 installModelSelection 会插一条。 */
const MODEL_SWITCH_PREFIX = '[model changed:'

/**
 * 取一条消息里的纯文本（图片之类的块忽略）。
 * @param {object | undefined} message - 消息。
 * @returns {string} 文本。
 */
export function textOf(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/**
 * 造一条注入消息。带上 `turn`，还原时靠它区分「本轮」与「上一轮」。
 * @param {string} text - 要注入的文本。
 * @param {number} [turn] - 当前轮次。
 * @returns {object} 冻结好的 user 消息。
 */
export function makeInjectedMessage(text, turn) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: INJECT_SOURCE_KIND, ...(Number.isSafeInteger(turn) ? { turn } : {}) },
  })
}

/**
 * 找出这一步新认领的用户原文消息。
 * @param {Array<object>} messages - step 准备落库的消息。
 * @returns {object[]} 认领到的用户消息（一般只有一条）。
 */
function claimedUserMessages(messages) {
  return Array.isArray(messages) ? messages.filter((message) => message?.source?.kind === 'user') : []
}

/**
 * 把一个 surface 节点归约成判定用的摘要。
 * @param {object} event - surface 节点事件。
 * @returns {{ seq: number, isInjected: boolean, isUser: boolean, isModelSwitch: boolean, turn: number | undefined, hasContent: boolean } | null} 摘要。
 */
function summarize(event) {
  if (event?.type !== 'user/message') return null
  const source = event.data?.source
  const kind = source?.kind
  const isModelSwitch = textOf(event.data).startsWith(MODEL_SWITCH_PREFIX)
  const turn = Number.isSafeInteger(source?.turn) ? source.turn : undefined
  return {
    seq: event.seq,
    isInjected: kind === INJECT_SOURCE_KIND && !isModelSwitch,
    isUser: kind === 'user',
    isModelSwitch,
    turn,
    hasContent: (event.data?.content ?? []).length > 0,
  }
}

/**
 * 纯判据：给 surface 节点顺序的摘要，算出需要还原的区间。
 *
 * 一轮在 surface 上的形状是「原文 + 前缀 / 后缀」（插件给出的是「前缀 / 原文 / 后缀」，
 * 落库后原文那条的位置由官方决定）。下一轮到来时，这些注入必须**整段**还原成那一条原文：
 * 只抹掉前缀、把后缀留在历史里的话，后缀会变成一条独立的 user 消息，永远赖在原文与下一条
 * 用户输入之间，等于被当成「用户后来又说了这么一句」——这正是「上一轮的后置词被下一轮读到」的根因。
 *
 * 三条硬规矩：
 * 1. **按位置算，不按事件号**：事件号大小与 surface 位置顺序并不总是一致（实测原文那条的号
 *    可能比注入那条小、位置却在前），拿号当位置用会让还原被静默丢弃。
 * 2. **从右往左处理**：一条注入的「原文」取它左边最近的那条用户消息，这样较新的轮次先认领，
 *    较老的注入不会把新轮的原文抢走。
 * 3. **相邻区间合并**：一轮的注入可能被还原区间拆成互不相邻的两组（同轮的另一条被前面的组
 *    认领走了），最后要把首尾相连的区间并成一次替换，别在历史里留下多余的空占位。
 *
 * @param {Array<ReturnType<typeof summarize>>} summaries - surface 顺序的摘要（可含 null）。
 * @param {number | undefined} currentTurn - 当前轮次。
 * @returns {{ restores: Array<{ fromIndex: number, toIndex: number, originalIndex: number }>, drops: Array<{ fromIndex: number, toIndex: number }> }} 还原与删除区间（按位置升序）。
 */
export function planRestore(summaries, currentTurn) {
  // 下标必须与 surface 严格对齐：非 user/message 的节点占位为 null 留在数组里，
  // 不能压缩掉——压缩过之后算出来的「位置」就不是 surface 位置了。
  const nodes = []
  for (let index = 0; index < summaries.length; index += 1) {
    const summary = summaries[index]
    nodes.push({ ...(summary ?? {}), index, isInjected: summary?.isInjected === true, isUser: summary?.isUser === true, isModelSwitch: summary?.isModelSwitch === true, turn: summary?.turn })
  }
  /** 属于更早轮次的注入节点在 nodes 里的下标。 */
  const earlier = []
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (!node.isInjected) continue
    if (Number.isSafeInteger(currentTurn) && Number.isSafeInteger(node.turn) && node.turn >= currentTurn) continue
    earlier.push(index)
  }
  if (earlier.length === 0) return { restores: [], drops: [] }

  /** 按轮次把注入节点合成一组：同一轮的前缀与后缀可能不相邻（中间夹着原文），但要一起处理。 */
  const groups = []
  let start = earlier[0]
  let end = earlier[0]
  let groupTurn = nodes[start].turn
  for (let position = 1; position < earlier.length; position += 1) {
    const index = earlier[position]
    if (groupTurn !== undefined && nodes[index].turn === groupTurn) {
      end = index
      continue
    }
    groups.push({ start, end })
    start = index
    end = index
    groupTurn = nodes[start].turn
  }
  groups.push({ start, end })

  // 从右往左：新轮次先认领原文，老注入抢不走。
  // 一组注入的可清理范围 = 组本身 ∪ 它到「最近那条原文」之间的注入；找不到原文就只抹掉这组注入。
  // 用户原文永远不许被抹掉：锚点找不到就只有删注入这一条窄区间。
  const restores = []
  const drops = []
  const covered = new Set()
  for (let position = groups.length - 1; position >= 0; position -= 1) {
    const group = groups[position]
    const anchor = findAnchor(nodes, group)
    if (anchor === -1) {
      for (let index = group.start; index <= group.end; index += 1) covered.add(index)
      drops.push({ fromIndex: group.start, toIndex: group.end })
      continue
    }
    const fromIndex = Math.min(group.start, anchor)
    const toIndex = Math.max(group.end, anchor)
    for (let index = fromIndex; index <= toIndex; index += 1) covered.add(index)
    restores.push({ fromIndex, toIndex, originalIndex: anchor })
  }
  // 没被任何区间覆盖的注入（原文已被压缩/遮蔽，或被别人换掉）：按位置单独抹掉。
  for (let position = 0; position < earlier.length; ) {
    if (covered.has(earlier[position])) {
      position += 1
      continue
    }
    let last = position
    while (last + 1 < earlier.length && earlier[last + 1] === earlier[last] + 1 && !covered.has(earlier[last + 1])) last += 1
    drops.push({ fromIndex: earlier[position], toIndex: earlier[last] })
    position = last + 1
  }

  return {
    restores: restores.sort((left, right) => left.fromIndex - right.fromIndex),
    drops: drops.sort((left, right) => left.fromIndex - right.fromIndex),
  }
}

/**
 * 找一组注入对应的那条用户原文，优先往左、其次往右。
 * 要求：原文在组外，且「组与原文之间」只夹着注入节点与模型切换提示——
 * 那些注入反正都要抹掉，而用户原文、工具结果之类一概不能牵连。
 * @param {Array<object>} nodes - 带 index 的节点。
 * @param {{ start: number, end: number }} group - 注入组。
 * @returns {number} 原文在 nodes 里的下标；没找到给 -1。
 */
function findAnchor(nodes, group) {
  // 先看组内：同一轮的原文可能就夹在前缀与后缀中间。
  for (let index = group.start; index <= group.end; index += 1) {
    if (nodes[index].isUser) return index
  }
  /** 从原文位置往组的方向看，中间是不是只有注入与模型切换提示。 */
  const cleanBetween = (anchor) => {
    const from = Math.min(anchor, group.start)
    const to = Math.max(anchor, group.end)
    return nodes.slice(from, to + 1).every((node) => node.isInjected || node.isModelSwitch)
  }
  // 按就近顺序逐个试：左边由近到远，再右边由近到远。碰到「路径不干净」的候选不能就此放弃——
  // 那条原文属于别的轮次，但更外面可能还有本轮的原文。
  for (let index = group.start - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (node.isModelSwitch || !node.isUser) continue
    if (cleanBetween(index)) return index
  }
  for (let index = group.end + 1; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (node.isModelSwitch || !node.isUser) continue
    if (cleanBetween(index)) return index
  }
  return -1
}

/**
 * 两条节点是不是同一轮的注入。`turn` 缺失时（老历史）宁可信「不是」，避免误吞别的轮次。
 * @param {ReturnType<typeof summarize>} left - 左节点。
 * @param {ReturnType<typeof summarize>} right - 右节点。
 * @returns {boolean} 同轮为真。
 */
function sameTurn(left, right) {
  if (left?.turn === undefined || right?.turn === undefined) return false
  return left.turn === right.turn
}

/**
 * 把 surface 上的节点归约成摘要列表。
 * @param {object} session - 会话。
 * @returns {Array<object | null>} 与 surface 节点一一对应的摘要。
 */
function summarizeSurface(session) {
  const summaries = []
  for (const seq of session.surface?.nodes ?? []) summaries.push(summarize(session.eventAt(seq)))
  return summaries
}

/**
 * 执行一个还原区间：把「注入 + 原文」那一段范围替换成那条用户原文。
 *
 * 区间按 surface 位置给出；原文既可能在注入的右边（常见），也可能在左边（实测）。
 * 无论哪种排列，替换都从两者中靠左的那个位置起、到靠右的那个位置止。
 *
 * @param {object} session - 会话。
 * @param {{ fromIndex: number, toIndex: number, originalIndex: number }} plan - 还原区间（surface 位置）。
 * @returns {boolean} 真的改动了 surface 为真。
 */
function applyRestore(session, plan) {
  const nodes = session.surface.nodes
  if (plan.fromIndex > plan.originalIndex || plan.toIndex < plan.originalIndex) return false
  const startIndex = Math.min(plan.fromIndex, plan.originalIndex)
  const endIndex = Math.max(plan.toIndex, plan.originalIndex)
  if (startIndex < 0 || endIndex >= nodes.length) return false
  const shadowed = nodes.slice(startIndex, endIndex + 1)
  const originalSeq = nodes[plan.originalIndex]
  const covered = shadowed.map((seq) => session.eventAt(seq))
  // 只允许抹掉：注入节点、模型切换提示、以及那一条用户原文。
  const safe = covered.every((event) => {
    const summary = summarize(event)
    if (summary === null) return false
    if (summary.isInjected || summary.isModelSwitch) return true
    return summary.isUser && summary.seq === originalSeq
  })
  if (!safe) return dropInjections(session, shadowed)
  const originalEvent = session.eventAt(originalSeq)
  if (originalEvent?.type !== 'user/message' || originalEvent.data?.source?.kind !== 'user') return dropInjections(session, shadowed)
  session.append(
    'user/message',
    createUserMessage({ content: originalEvent.data.content ?? [], source: originalEvent.data.source }),
    {
      surfaceOp: { op: 'replace', startSeq: nodes[startIndex], endSeq: nodes[endIndex] },
      sourceEventSeqs: shadowed,
    },
  )
  return true
}

/**
 * 还原区间落空时的兜底：这段里有非注入节点（结构和我们算的不一样），那就退一步——
 * 仅把那几个注入节点抹掉，绝不碰用户原文。宁可多留一条空占位，也不能让注入留在历史里。
 * @param {object} session - 会话。
 * @param {number[]} shadowed - 原计划要替换的 surface 节点。
 * @returns {boolean} 真的改动了 surface 为真。
 */
function dropInjections(session, shadowed) {
  const nodes = session.surface.nodes
  let changed = false
  for (const seq of shadowed) {
    const index = nodes.indexOf(seq)
    if (index === -1) continue
    if (summarize(session.eventAt(seq))?.isInjected !== true) continue
    session.append('user/message', tombstoneMessage(), {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    })
    changed = true
  }
  return changed
}

/**
 * 造一条空内容的占位消息：模型看不到内容，聊天记录也不收替换事件。
 * @returns {object} 冻结好的 user 消息。
 */
function tombstoneMessage() {
  return createUserMessage({ content: [], source: { kind: INJECT_SOURCE_KIND, dropped: true } })
}

/**
 * 执行一个删除区间：把这段注入整段抹掉，不留下任何消息。
 * @param {object} session - 会话。
 * @param {{ fromIndex: number, toIndex: number }} plan - 删除区间（surface 位置）。
 * @returns {boolean} 真的改动了 surface 为真。
 */
function applyDrop(session, plan) {
  const nodes = session.surface.nodes
  if (plan.fromIndex < 0 || plan.toIndex >= nodes.length || plan.fromIndex > plan.toIndex) return false
  const shadowed = nodes.slice(plan.fromIndex, plan.toIndex + 1)
  const covered = shadowed.map((seq) => session.eventAt(seq))
  if (!covered.every((event) => summarize(event)?.isInjected === true)) return false
  session.append('user/message', tombstoneMessage(), {
    surfaceOp: { op: 'replace', startSeq: nodes[plan.fromIndex], endSeq: nodes[plan.toIndex] },
    sourceEventSeqs: shadowed,
  })
  return true
}

/**
 * 还原上一轮留下的注入。
 *
 * **当前版本不再调用它**：用户已拍板「注入永久保留、完全不还原」，`onPreStep` 只做注入，
 * 不做任何清除。这套判据与它的纯逻辑测试（`.agents/checks/verify-logic.mjs`）保留在这里，
 * 是为了将来若要把「自动清除」重新做成选项时不必从零重写；`planRestore` 是纯函数，
 * 不依赖 session，随时可以被重新接回 `onPreStep`。
 *
 * @param {object} session - 会话。
 * @param {number | undefined} currentTurn - 当前轮次。
 * @returns {boolean} 改动过 surface 为真。
 */
export function restoreLeftovers(session, currentTurn) {
  const { restores, drops } = planRestore(summarizeSurface(session), currentTurn)
  let changed = false
  for (const plan of restores) if (applyRestore(session, plan)) changed = true
  for (const plan of drops) if (applyDrop(session, plan)) changed = true
  return changed
}

/**
 * 抹掉**内容为空**的注入占位节点（`source.kind === 'prompt-inject'` 且 `content` 为空）。
 *
 * 这些空节点是历史遗留：早期版本会在下一轮「还原」上一轮的注入，还原处会留下一条空占位。
 * 现在的行为是**注入永久保留、完全不还原**，于是这些空卡片成了没有信息量的噪声，
 * 顺手收掉；非空的注入正文一律不动（那正是要保留的上下文块）。
 *
 * @param {object} session - 会话。
 * @returns {boolean} 真的清理过为真。
 */
function removeEmptyInjectNodes(session) {
  let changed = false
  for (const seq of [...(session.surface.nodes ?? [])]) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    if (event.data?.source?.kind !== INJECT_SOURCE_KIND) continue
    if ((event.data?.content ?? []).length > 0) continue
    session.append('user/message', createUserMessage({ content: [], source: { kind: INJECT_SOURCE_KIND, dropped: true } }), {
      surfaceOp: { op: 'remove', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    })
    changed = true
  }
  if (changed) session.deriveMessages()
  return changed
}

/**
 * 框架安全网：范围替换让 surface 变短之后，官方的派生消息缓存会留下脏状态
 * （`derived` 被清空、`derivedNodes` 留在旧值），下一次从错位置切片会漏消息。
 * 还原之后立刻调一次，把缓存整体重建。
 * @param {object} session - 会话。
 * @returns {boolean} 触发过重建为真。
 */
export function repairDerivedCache(session) {
  try {
    const nodeCount = session.surface?.nodes?.length ?? 0
    if (session.derivedNodes <= nodeCount) return false
    session.deriveMessages()
    return true
  } catch {
    return false
  }
}

/**
 * 每轮的注入器：一个 apply 生命周期一个实例即可。
 */
export class SessionInjector {
  /**
   * @param {() => Promise<{ revision: number, slots: object }>} readConfig - 读配置的函数。
   * @param {(agent: object) => { modelKey: string | null, route: { provider?: string, model?: string } | null }} turnOfAgent - 「这一步走哪个模型」的判据（见 modelRoute.js）。
   */
  constructor(readConfig, turnOfAgent) {
    this.readConfig = readConfig
    this.turnOfAgent = turnOfAgent
    /** 注入/清理出问题时的记日志回调。 */
    this.onWarn = () => {}
  }

  /**
   * `agent/pre-step` 监听器本体。
   *
   * 行为约定（用户拍板）：**注入永久保留，完全不还原**。也就是说这里不再对上一轮的
   * 前后缀做任何 `surfaceOp.replace`——那些注入就是留在历史里的上下文块。
   * 代价是上一轮的后置词会留在下一轮上下文里，可能被模型当成「用户又补充了一句」。
   * 唯一还做的 surface 操作是收掉历史遗留的空占位节点（见 `removeEmptyInjectNodes`）。
   *
   * @param {{ agent: object, messages: Array<object>, turn?: number }} payload - 事件载荷。
   * @param {() => Promise<object>} next - 后续 handler。
   * @returns {Promise<object>} 这一步的决定。
   */
  async onPreStep(payload, next) {
    const decision = await next()
    if (decision?.kind === 'reject') return decision
    const agent = payload?.agent
    const session = agent?.session
    if (session === undefined) return decision
    const claimed = claimedUserMessages(decision.messages)
    if (claimed.length === 0) {
      repairDerivedCache(session)
      return decision
    }
    let slots
    try {
      slots = (await this.readConfig()).slots
    } catch (error) {
      this.onWarn('read rules failed', error)
      return decision
    }
    const { modelKey, route } = this.turnOfAgent(agent)
    // 前后缀在**注入那一刻**渲染成成品：注入会永久留在历史里，`{{cwd}}` 这类字段以后不会再变。
    const values = templateValuesOfAgent(agent, route)
    const prefix = renderTemplate(resolveSlot(slots, 'user.prefix', modelKey), values)
    const suffix = renderTemplate(resolveSlot(slots, 'user.suffix', modelKey), values)
    try {
      removeEmptyInjectNodes(session)
    } catch (error) {
      this.onWarn('remove empty injection placeholders failed', error)
    }
    let messages = decision.messages
    if (prefix !== '' || suffix !== '') {
      const anchor = claimed[claimed.length - 1]
      const index = messages.indexOf(anchor)
      const head = index === -1 ? [] : messages.slice(0, index)
      const tail = index === -1 ? [] : messages.slice(index + 1)
      const injected = []
      if (prefix !== '') injected.push(makeInjectedMessage(prefix, payload.turn))
      injected.push(anchor)
      if (suffix !== '') injected.push(makeInjectedMessage(suffix, payload.turn))
      messages = [...head, ...injected, ...tail]
    }
    return { ...decision, messages }
  }
}

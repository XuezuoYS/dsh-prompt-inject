/**
 * 「这次请求会走哪条模型路由」的唯一判据。
 *
 * 为什么不能只看 `session.requestContext()`：它是**最近一次已提交请求**的路由。
 * 而 `agent/pre-step` 与 section 求值都发生在这一步的路由解析之前（官方 agent loop 的顺序是
 * 「组装 system → agent/pre-step → agent/request → request/header」），所以用户在下拉里换了模型后，
 * 我们读到的还是上一个模型 —— 结果就是「配给 A 的规则」被打进 B 的第一次请求里。
 *
 * 官方真正的判据是**模型选择投影**（`ctx.sessionProjections` 的 `modelSelection` 单元）：
 * - `pending`：用户刚点、还没发出去的那个（桌面端 `session/selectModel` 落的 `model/selection` 事件）；
 * - `lastUsed`：已经发出去过的最后一条路由。
 * 官方 `dsh-agent` 的 `installModelSelection` 用的就是同一份状态，所以插件命中哪个模型 == 实际走哪个模型。
 *
 * 拿不到投影（headless 之类的组合没挂这个单元）时退回到「最近提交的请求 → agent 建立时的路由」，
 * 与改动前行为一致，不会更糟。
 *
 * @module dsh-prompt-inject/modelRoute
 */

import { modelKeyOf } from './ruleResolver.js'

/** 官方模型选择投影的键（由 `@deepseek-ai/dsh-api-session-controller` 注册）。 */
export const MODEL_SELECTION_KEY = 'modelSelection'

/**
 * 取一个官方服务，取不到就当没有。
 * @param {object | undefined} ctx - 插件上下文。
 * @param {string} name - 服务名。
 * @returns {any} 服务或 undefined。
 */
function serviceOf(ctx, name) {
  try {
    return ctx?.get?.(name)
  } catch {
    return undefined
  }
}

/**
 * 从投影状态里取路由明细：`pending` 优先，其次 `lastUsed`。
 * @param {{ pending?: object | null, lastUsed?: object | null } | undefined} state - 投影状态。
 * @returns {{ provider: string, model: string } | null} 路由；两个都空给 null。
 */
export function routeOfSelection(state) {
  if (state === undefined || state === null) return null
  const pending = modelKeyOf(state.pending?.provider, state.pending?.model)
  if (pending !== null) return { provider: state.pending.provider, model: state.pending.model }
  const lastUsed = modelKeyOf(state.lastUsed?.provider, state.lastUsed?.model)
  if (lastUsed !== null) return { provider: state.lastUsed.provider, model: state.lastUsed.model }
  return null
}

/**
 * 从投影状态里取模型键：`pending` 优先，其次 `lastUsed`。
 * @param {{ pending?: object | null, lastUsed?: object | null } | undefined} state - 投影状态。
 * @returns {string | null} 模型键；两个都空给 null。
 */
export function modelKeyOfSelection(state) {
  const route = routeOfSelection(state)
  return route === null ? null : modelKeyOf(route.provider, route.model)
}

/**
 * 这个会话「接下来这次请求」的路由明细。
 * @param {object | undefined} ctx - 插件上下文。
 * @param {object | undefined} session - 会话。
 * @returns {{ provider: string, model: string } | null} 路由；没有投影或投影里没东西给 null。
 */
export function routeOfSession(ctx, session) {
  if (session === undefined || session === null) return null
  const projections = serviceOf(ctx, 'sessionProjections')
  if (projections === undefined || projections === null || typeof projections.stateOf !== 'function') return null
  let state
  try {
    state = projections.stateOf(session, MODEL_SELECTION_KEY)
  } catch {
    // 投影单元没注册、或会话形状不对：当没有，走回退链。
    return null
  }
  return routeOfSelection(state)
}

/**
 * 这个会话「接下来这次请求」的模型键。
 * @param {object | undefined} ctx - 插件上下文。
 * @param {object | undefined} session - 会话。
 * @returns {string | null} 模型键；没有投影或投影里没东西给 null。
 */
export function modelKeyOfSession(ctx, session) {
  const route = routeOfSession(ctx, session)
  return route === null ? null : modelKeyOf(route.provider, route.model)
}

/**
 * 当前 agent 的路由明细：投影 → 最近提交的请求 → agent 建立时的路由。
 * @param {object | undefined} ctx - 插件上下文。
 * @param {object | undefined} agent - 当前 agent。
 * @returns {{ provider: string, model: string } | null} 路由，取不到给 null。
 */
export function routeOfAgent(ctx, agent) {
  if (agent === undefined || agent === null) return null
  const projected = routeOfSession(ctx, agent.session)
  if (projected !== null) return projected
  const route = agent.session?.requestContext?.()
  if (modelKeyOf(route?.provider, route?.model) !== null) return { provider: route.provider, model: route.model }
  if (modelKeyOf(agent.options?.provider, agent.options?.model) !== null) return { provider: agent.options.provider, model: agent.options.model }
  return null
}

/**
 * 当前 agent 的模型键：投影 → 最近提交的请求 → agent 建立时的路由。
 * @param {object | undefined} ctx - 插件上下文。
 * @param {object | undefined} agent - 当前 agent。
 * @returns {string | null} 模型键，取不到给 null。
 */
export function modelKeyOfAgent(ctx, agent) {
  const route = routeOfAgent(ctx, agent)
  return route === null ? null : modelKeyOf(route.provider, route.model)
}

/**
 * 组装 system 提示词时用的模型键。
 * 这次组装的变量里已经带着官方快照（`installModelSelection` 写进去的 provider / model），
 * 它比任何回退都准，有就用它。
 *
 * @param {object | undefined} ctx - 插件上下文。
 * @param {object | undefined} agent - 组装上下文里的 agent。
 * @param {object | undefined} assembled - 组装结果（带 `variables`）。
 * @returns {string | null} 模型键，取不到给 null。
 */
export function modelKeyOfAssembly(ctx, agent, assembled) {
  const variables = assembled?.variables
  const fromAssembly = modelKeyOf(variables?.provider, variables?.model)
  if (fromAssembly !== null) return fromAssembly
  return modelKeyOfAgent(ctx, agent)
}

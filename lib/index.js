/**
 * host 半：装配与注册。
 *
 * 拿到的四件事：
 * - `/api/dsh-prompt-inject/*` 端点（读状态、写规则）；
 * - `agent/pre-step`：用户前后缀的注入与还原；
 * - 全局 `systemPrompt.section()`：4 个 system 中间锚点；
 * - 全局 `system-prompt/assemble`：改写官方 persona 的头 / 尾（两个独立注入点）。
 *
 * 「这轮算哪个模型」统一走 modelRoute.js（官方的模型选择投影优先），两条注入路径共用同一个判据。
 * 规则文本里的 `{{模板字段}}` 由我们按同一条路由渲染成成品（见 templateFields.js）：
 * 前后缀在注入那一刻渲染，system 段在 `assemble` 里渲染并关掉官方插值。
 *
 * @module dsh-prompt-inject
 */

import { ConfigStore } from './configStore.js'
import { routeOfAgent } from './modelRoute.js'
import { modelKeyOf } from './ruleResolver.js'
import { SessionInjector } from './sessionInjector.js'
import { registerSettingsApi } from './settingsApi.js'
import { registerSystemSections } from './systemSections.js'

/** 插件名（与 package.json 的 name 一致）。 */
export const name = 'dsh-prompt-inject'

/** 需要的官方服务；缺一个就用不了对应能力，交给 cordis 等依赖。 */
export const inject = ['connection', 'llm', 'systemPrompt', 'sessions']

/**
 * 装配 host 半。
 * @param {object} ctx - 插件上下文。
 * @returns {void}
 */
export function apply(ctx) {
  const store = new ConfigStore()

  /**
   * 记一条诊断日志（不打断任何流程）。
   * @param {string} message - 说明。
   * @param {unknown} error - 原始错误。
   * @returns {void}
   */
  const onWarn = (message, error) => {
    ctx.logger?.('dsh-prompt-inject')?.warn(`%s: %s`, message, error instanceof Error ? error.message : String(error))
  }

  /** 读配置的函数：注入器与 system 段共用。 */
  const readConfig = () => store.read()

  // system 段是同步求值，不能 await；所以 systemSections 只保留一份最新快照，
  // 由这里在「启动、写成功、system-prompt/change」三个时机刷新。
  let refreshSystemRules = () => {}
  /** 让 system 段重新读一次规则。 */
  const refreshRules = () => refreshSystemRules()

  registerSettingsApi(ctx, store, onWarn, refreshRules)
  refreshSystemRules = registerSystemSections(ctx, readConfig, onWarn)

  const injector = new SessionInjector(readConfig, (agent) => {
    // 命中哪个模型、模板字段各是什么值，都按同一条路由判据算（见 modelRoute.js）。
    const route = routeOfAgent(ctx, agent)
    return { modelKey: modelKeyOf(route?.provider, route?.model), route }
  })
  injector.onWarn = onWarn
  ctx.effect(
    () =>
      ctx.on(
        'agent/pre-step',
        (payload, next) => injector.onPreStep(payload, next),
        // 最外层：先让官方 handler（含模型切换提示）把 messages 补齐，再在用户消息两侧插注入。
        { prepend: true },
      ),
    'dsh-prompt-inject: user prefix/suffix',
  )
}

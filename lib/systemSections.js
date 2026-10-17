/**
 * system 注入：中间锚点用全局 `section()`，persona 头 / 尾改写官方已有的那两段。
 *
 * 为什么不能注册 `deployment:persona-prefix`：桌面 preset 已经挂了官方 `dsh-persona`，
 * 同一作用域重名注册会被静默拒绝（fiber 进失败态，不抛错）。所以头尾只能改写组装结果。
 *
 * 头（`system.personaHead`）与尾（`system.personaTail`）是两个独立注入点：各自只影响
 * 对应的那一段，不配就原样保留官方默认。
 *
 * 模板字段（`{{model}}` 之类）由**我们**在 `assemble` 里渲染完再交给官方，并把这几段标成
 * `interpolate: false`：官方的插值器遇到没注册的名字会直接抛错，整次组装就崩了；
 * 自己渲染还能在取不到值时把 `{{name}}` 原样留着（见 templateFields.js）。
 *
 * @module dsh-prompt-inject/systemSections
 */

import { middleSectionPoints, replacedSectionPoints } from './injectPoints.js'
import { modelKeyOfAgent, modelKeyOfAssembly, routeOfAgent } from './modelRoute.js'
import { resolveSlot } from './ruleResolver.js'
import { mergeTemplateValues, renderTemplate, templateValuesOfAgent } from './templateFields.js'

/** 本插件用 `section()` 注册的中间锚点段名：这些段的文本永远由我们渲染。 */
const MIDDLE_SECTION_NAMES = new Set(middleSectionPoints().map((point) => point.sectionName))

/**
 * 段定义片段：文本已经是我们渲染好的成品，一律关掉官方插值。
 * @param {string} text - 段文本。
 * @returns {{ text: string, interpolate: false }} 段定义片段。
 */
function sectionText(text) {
  return { text, interpolate: false }
}

/**
 * 注册 system 注入。
 *
 * @param {object} ctx - 插件上下文。
 * @param {() => Promise<{ revision: number, slots: object }>} readConfig - 读配置的函数。
 * @param {(message: string, error: unknown) => void} [onWarn] - 记日志回调。
 * @returns {() => void} 让段落重新读一次规则（写成功之后调用）。
 */
export function registerSystemSections(ctx, readConfig, onWarn = () => {}) {
  /** 最新配置：assemble 是同步求值，不能在里面 await。 */
  let currentSlots = {}
  let reading = false

  /** 拉一次最新配置（不 await，给下一次组装用）。 */
  const refresh = () => {
    if (reading) return
    reading = true
    readConfig().then(
      (state) => {
        currentSlots = state.slots
        reading = false
      },
      (error) => {
        reading = false
        onWarn('read rules for system sections failed', error)
      },
    )
  }

  /**
   * 解析某个注入点在这次组装下的文本。
   * 会话标题、压缩摘要这类内部调用没有 agent，此时只有「全部模型」的规则生效。
   * @param {string} slotKey - 注入点键。
   * @param {object | undefined} context - 组装上下文。
   * @returns {string} 文本。
   */
  const resolveForContext = (slotKey, context) => resolveSlot(currentSlots, slotKey, modelKeyOfAgent(ctx, context?.agent))

  refresh()

  ctx.effect(function* registerMiddleSections() {
    for (const point of middleSectionPoints()) {
      yield ctx.systemPrompt.section({
        name: point.sectionName,
        order: point.order,
        text: (context) => {
          try {
            return resolveForContext(point.key, context)
          } catch (error) {
            onWarn(`resolve ${point.key} failed`, error)
            return ''
          }
        },
      })
    }
  }, 'dsh-prompt-inject: system sections')

  ctx.effect(() => ctx.on('system-prompt/change', refresh), 'dsh-prompt-inject: refresh system rules')

  ctx.effect(
    () =>
      ctx.on('system-prompt/assemble', async (assembly, context, next) => {
        const assembled = await next()
        try {
          refresh()
          // 头 / 尾改写用的是这次组装已经定下来的路由（官方写在 variables 里），比回退链更准。
          const modelKey = modelKeyOfAssembly(ctx, context?.agent, assembled)
          // 模板字段的取值同样以这次组装算出的 variables 为准，缺了才退回同一条路由判据算出的值。
          const values = mergeTemplateValues(templateValuesOfAgent(context?.agent, routeOfAgent(ctx, context?.agent)), assembled.variables)
          /** 段名 → 这次要替换成的文本；空串表示保持官方默认。 */
          const rewrites = new Map()
          for (const point of replacedSectionPoints()) {
            const text = resolveSlot(currentSlots, point.key, modelKey)
            if (text !== '') rewrites.set(point.replaces, text)
          }
          let touched = false
          const sections = assembled.sections.map((section) => {
            // 中间锚点的文本出自我们的 provider，永远自己渲染；官方那两段只在有规则改写时才碰——
            // 没配就得原样留着，官方段自己的插值（0.2.1 起官方只注册 provider / model 两个变量）还得靠官方的插值器。
            const raw = MIDDLE_SECTION_NAMES.has(section.name) ? section.text : rewrites.get(section.name)
            if (raw === undefined) return section
            touched = true
            return { ...section, ...sectionText(renderTemplate(raw, values)) }
          })
          return touched ? { ...assembled, sections } : assembled
        } catch (error) {
          onWarn('rewrite persona sections failed', error)
          return assembled
        }
      }),
    'dsh-prompt-inject: replace official sections',
  )

  return refresh
}

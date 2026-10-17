/**
 * 注入点表：注入点键、system 段位 order / 官方段名、双语标签。
 *
 * host 与 client 都按这份表工作，但客户端半是手写 bundle（不走构建链），
 * 不能 import 这个文件，所以在 lib/client.js 里内联了一份同样的表。
 * 改表时两边一起改，`.agents/` 里有对照记录。
 *
 * 每个注入点都是一串规则列表，没有例外；persona 的头和尾是两个独立注入点。
 *
 * @module dsh-prompt-inject/injectPoints
 */

/** 官方 persona 两段的段名：改写这两段（不能重名注册，见 docs/injectPoint.md）。 */
export const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'
export const PERSONA_SUFFIX_SECTION = 'deployment:persona-suffix'

/**
 * 注入点定义表，顺序即设置页里的显示顺序。
 *
 * - `sectionName` 有值 = 中间锚点，用全局 `systemPrompt.section()`，`order` 是段位；
 * - `replaces` 有值 = 改写官方已有的那一段（persona 头 / 尾）；
 * - `anchor` 只用于界面提示，告诉用户这一项对应官方哪一段。
 *
 * @type {ReadonlyArray<{
 *   key: string,
 *   order?: number,
 *   sectionName?: string,
 *   replaces?: string,
 *   anchor?: { zh: string, en: string },
 *   label: { zh: string, en: string },
 *   hint?: { zh: string, en: string },
 * }>}
 */
export const INJECT_POINTS = Object.freeze([
  {
    key: 'user.prefix',
    label: { zh: '用户前置词', en: 'User prefix' },
    hint: { zh: '插在当前用户输入之前，每轮只注入一次。', en: 'Inserted before the current user input, once per turn.' },
    notice: {
      zh: '注意：注入后不会自动清除。这段文字会一直留在会话历史里，和用户原文一样是 user 消息，之后每一轮都还能被模型读到。',
      en: 'Note: this text is never removed automatically. It stays in the session history as a user message and remains readable in every later turn.',
    },
  },
  {
    key: 'user.suffix',
    label: { zh: '用户后置词', en: 'User suffix' },
    hint: { zh: '插在当前用户输入之后，每轮只注入一次。', en: 'Inserted after the current user input, once per turn.' },
    notice: {
      zh: '注意：注入后不会自动清除。它会留在历史里，并紧跟在用户原文之后——下一轮可能被模型当成「用户又补充的一句」来读，请只写不会引起误解的内容。',
      en: 'Note: this text is never removed automatically. It stays right after the user message and may be read as an extra user instruction in later turns, so keep it unambiguous.',
    },
  },
  {
    key: 'system.personaHead',
    replaces: PERSONA_PREFIX_SECTION,
    anchor: { zh: '官方 persona 头', en: 'official persona head' },
    label: { zh: 'system 头部', en: 'System head' },
    hint: { zh: '替换官方 persona 段的头（官方用于告知模型当前调用的模型名）；不配就保持官方默认。', en: 'Replaces the official persona head (the official text that tells the model which model is in use); leave empty to keep the default.' },
  },
  {
    key: 'system.personaTail',
    replaces: PERSONA_SUFFIX_SECTION,
    anchor: { zh: '官方 persona 尾', en: 'official persona tail' },
    label: { zh: 'system 尾部', en: 'System tail' },
    hint: { zh: '替换官方 persona 段的尾（0.2.1 起官方默认为空串）；不配就保持官方默认。', en: 'Replaces the official persona tail (empty by default since 0.2.1); leave empty to keep the default.' },
  },
  {
    key: 'system.beforeTools',
    order: 950,
    sectionName: 'prompt-inject:beforeTools',
    anchor: { zh: 'order 950', en: 'order 950' },
    label: { zh: 'system 中段 · 工具说明之前', en: 'System middle · before tool docs' },
  },
  {
    key: 'system.afterTools',
    order: 3050,
    sectionName: 'prompt-inject:afterTools',
    anchor: { zh: 'order 3050', en: 'order 3050' },
    label: { zh: 'system 中段 · 工具说明之后', en: 'System middle · after tool docs' },
  },
  {
    key: 'system.middle',
    order: 9800,
    sectionName: 'prompt-inject:middle',
    anchor: { zh: 'order 9800', en: 'order 9800' },
    label: { zh: 'system 中段 · 结构化输出之前', en: 'System middle · before structured output' },
  },
  {
    key: 'system.last',
    order: 10300,
    sectionName: 'prompt-inject:last',
    anchor: { zh: 'order 10300', en: 'order 10300' },
    label: { zh: 'system 末尾', en: 'System end' },
    hint: { zh: '落在官方 persona 尾之后，是 system 的最后一段。', en: 'Lands after the official persona tail, at the very end of system.' },
  },
])

/**
 * 中间锚点注入点（用 section 注册的那些）。
 * @returns {Array<object>} 注入点。
 */
export function middleSectionPoints() {
  return INJECT_POINTS.filter((point) => point.sectionName !== undefined)
}

/**
 * 改写官方已有段的注入点（persona 头 / 尾）。
 * @returns {Array<object>} 注入点。
 */
export function replacedSectionPoints() {
  return INJECT_POINTS.filter((point) => point.replaces !== undefined)
}

/** 配置结构版本。 */
export const CONFIG_VERSION = 1

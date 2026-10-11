/**
 * 模板字段：官方提示词变量（`{{name}}`）的白名单 + 中文注释，以及把 `{{}}` 换成值的纯函数。
 *
 * 官方 `@deepseek-ai/dsh-system-prompt` 的段文本支持 `{{name}}`，桌面部署一共注册了三个，
 * 都由官方 agent loop 提供（见发行包 `lib/index.js` 的 `ctx.systemPrompt.variable(...)`）：
 *
 * | 字段 | 值 |
 * | --- | --- |
 * | `provider` | `agent.options.provider` |
 * | `model` | `agent.options.model` |
 * | `cwd` | `agent.session.header.cwd` |
 *
 * 官方的渲染器遇到**没注册的名字直接抛错**，会把整次 prompting 组装带崩；所以插件自己渲染：
 * system 段由我们在 `system-prompt/assemble` 里替换成成品（标 `interpolate: false`），
 * 用户前后缀在注入前就渲染好。两边都用这里的 `renderTemplate`。
 *
 * 白名单是静态的（不去反射官方的注册表）：字段要给人看、还要配注释，静态表更好维护，
 * 也避开了 `systemPrompt.layers` 这类内部结构。
 *
 * @module dsh-prompt-inject/templateFields
 */

/**
 * 可用的模板字段，顺序即设置页里的显示顺序。
 *
 * @type {ReadonlyArray<{ name: string, label: string, note: string }>}
 */
export const TEMPLATE_FIELDS = Object.freeze([
  {
    name: 'model',
    label: '模型名',
    note: '这次请求实际用的模型 id（如 deepseek-flash）；官方 persona 头用的就是它。',
  },
  {
    name: 'provider',
    label: '提供方',
    note: '模型属于哪个 provider（如 deepseek-account）。',
  },
  {
    name: 'cwd',
    label: '工作目录',
    note: '当前会话的工作目录绝对路径；官方 persona 尾用的就是它。',
  },
])

/** `{{name}}` 组。 */
const GROUP_AT = /\{\{([^{}]*)\}\}/g

/** 合法的字段名，与官方一致：小写字母开头，只含小写字母、数字、下划线。 */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

/**
 * 把模板字段渲染进文本。
 *
 * 只有「认得的字段 + 这次拿到的非空字符串值」才替换；其余情况（拼错的名字、插件没注册的、
 * 这次请求取不到值的、名字不合官方规则的）**原样留着 `{{name}}`**，绝不抛错——正文里留个
 * 占位符，比让整次组装失败好得多。返回的是新字符串，不改入参。
 *
 * @param {string} text - 规则文本。
 * @param {Record<string, unknown> | undefined} values - 这次能用的字段值。
 * @returns {string} 渲染后的文本。
 */
export function renderTemplate(text, values) {
  if (typeof text !== 'string') return ''
  if (text === '' || text.indexOf('{{') === -1) return text
  if (values === undefined || values === null) return text
  return text.replace(GROUP_AT, (group, name) => {
    if (!VARIABLE_NAME.test(name) || !Object.hasOwn(values, name)) return group
    const value = values[name]
    return typeof value === 'string' && value !== '' ? value : group
  })
}

/**
 * 从 agent 上取模板字段的值，用作兜底（组装期之外只有这个来源）。
 *
 * @param {object | undefined} agent - 当前 agent。
 * @param {{ provider?: string, model?: string } | null | undefined} [route] - 「这一步走哪条路由」的明细（见 modelRoute.js）；给了就优先用它。
 * @returns {{ provider: string | undefined, model: string | undefined, cwd: string | undefined }} 字段值。
 */
export function templateValuesOfAgent(agent, route) {
  return {
    provider: route?.provider ?? agent?.options?.provider,
    model: route?.model ?? agent?.options?.model,
    cwd: agent?.session?.header?.cwd,
  }
}

/**
 * 组装期的取值：官方这次组装算出来的变量有非空值就用它（可能被 agent 作用域遮蔽过），
 * 否则退回兜底值。
 *
 * @param {object} base - 兜底值（一般来自 `templateValuesOfAgent`）。
 * @param {Record<string, unknown> | undefined} variables - 官方组装结果里的 `variables`。
 * @returns {object} 合并后的字段值。
 */
export function mergeTemplateValues(base, variables) {
  const merged = { ...base }
  if (variables === undefined || variables === null) return merged
  for (const field of TEMPLATE_FIELDS) {
    const value = variables[field.name]
    if (typeof value === 'string' && value !== '') merged[field.name] = value
  }
  return merged
}

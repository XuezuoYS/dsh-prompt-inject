// 实验 1d：能否「全部全局注册」实现按 agent/模型区分
//  - 中间锚点：全局 section + 函数式 text（assemble 时按 context.agent 求值）
//  - persona 头尾：全局 system-prompt/assemble 监听器按 context.agent 改写
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, {
  PERSONA_PREFIX_SECTION,
  PERSONA_SUFFIX_SECTION,
  renderPrompt,
} from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'

const rule = (t) => console.log(`\n===== ${t} =====`)
const root = new Context()
await root.plugin(SystemPrompt, { personaPrefix: 'GLOBAL-HEAD', personaSuffix: 'GLOBAL-TAIL' })
const textOf = (a, name) => {
  const s = a.sections.find((x) => x.name === name)
  return s === undefined ? '(absent)' : JSON.stringify(s.text)
}

// 每个 agent 的规则表（模拟从配置文件读出来的）
const RULES = {
  'deepseek-flash': { head: 'FLASH-HEAD', mid: 'FLASH-MID' },
  'qwen3-max': { head: 'QWEN-HEAD', mid: 'QWEN-MID' },
}
const rulesFor = (agent) => RULES[agent?.options?.model] ?? undefined

rule('1. 全局注册中间锚点（函数式 text，按 context.agent 求值）')
root.systemPrompt.section({
  name: 'prompt-inject:beforeTools',
  order: 950,
  text: (context) => rulesFor(context.agent)?.mid ?? '',
})

rule('2. 全局注册 system-prompt/assemble 监听器，改写官方 persona 头尾')
root.on('system-prompt/assemble', async (assembly, context, next) => {
  const assembled = await next()
  const rules = rulesFor(context.agent)
  if (rules === undefined) return assembled
  return {
    ...assembled,
    sections: assembled.sections.map((s) => {
      if (s.name === PERSONA_PREFIX_SECTION) return { ...s, text: rules.head }
      if (s.name === PERSONA_SUFFIX_SECTION) return { ...s, text: rules.head + '-TAIL' }
      return s
    }),
  }
})

const mk = (model) => {
  const agent = { id: `agent-${model}`, options: { provider: 'p', model } }
  const scope = createScope(root, agent)
  return { agent, scope: agent }
}

rule('3. deepseek-flash 的 agent')
const a1 = mk('deepseek-flash')
const r1 = await root.systemPrompt.assemble({ agent: a1.agent, scope: a1.scope })
console.log(renderPrompt(r1))

rule('4. qwen3-max 的 agent（同一份全局注册，输出不同）')
const a2 = mk('qwen3-max')
const r2 = await root.systemPrompt.assemble({ agent: a2.agent, scope: a2.scope })
console.log(renderPrompt(r2))

rule('5. 没配规则的模型（预期：官方 persona 原样 + 中间段为空被丢掉）')
const a3 = mk('unknown-model')
const r3 = await root.systemPrompt.assemble({ agent: a3.agent, scope: a3.scope })
console.log(renderPrompt(r3))

rule('判定')
const pass =
  textOf(r1, PERSONA_PREFIX_SECTION) === '"FLASH-HEAD"' &&
  textOf(r1, 'prompt-inject:beforeTools') === '"FLASH-MID"' &&
  textOf(r2, PERSONA_PREFIX_SECTION) === '"QWEN-HEAD"' &&
  textOf(r2, 'prompt-inject:beforeTools') === '"QWEN-MID"' &&
  textOf(r3, PERSONA_PREFIX_SECTION) === '"GLOBAL-HEAD"' &&
  textOf(r3, 'prompt-inject:beforeTools') === '""'
console.log(pass ? 'PASS：全局注册 + 函数式文本/waterfall，即可按 agent 与模型区分，且没配就退回官方默认' : 'FAIL：见上面各行')
process.exit(pass ? 0 : 1)

// 端到端（真官方 SystemPrompt）：插件改写的段交给官方渲染器后，`{{字段}}` 的落位与不炸的行为。
//
// 这一份是**真集成**：真 `@deepseek-ai/dsh-system-prompt` 服务 + 真 `renderPrompt`，不是假 ctx。
// 官方插值器遇到未注册的变量会直接抛错，所以这段必须真跑一遍。
//
// 用法：node .agents/checks/verify-assemble-render.mjs（需要官方包，见 .agents/checks/README.md）
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { registerSystemSections } from '../../lib/systemSections.js'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// 官方桌面部署的人设原文就长这样（personaPrefix / personaSuffix）。
const PERSONA_PREFIX = 'You are a coding agent powered by the {{model}} model.'
const PERSONA_SUFFIX = 'Your working directory is {{cwd}}.'

const root = new Context()
await root.plugin(SystemPrompt, {
  personaPrefix: PERSONA_PREFIX,
  personaSuffix: PERSONA_SUFFIX,
  includeHarnessIdentity: true,
})

// 官方 agent loop 注册的三个变量，这里照抄一份（值都从 assemble 的 context.agent 上取）。
root.systemPrompt.variable('provider', (context) => context.agent?.options.provider)
root.systemPrompt.variable('model', (context) => context.agent?.options.model)
root.systemPrompt.variable('cwd', (context) => context.agent?.session.header.cwd)

const slots = {
  'system.beforeTools': { rules: [{ id: 'b', enabled: true, text: '工具说明之前 @ {{cwd}}（{{model}}）', models: { all: true, list: [] } }] },
  'system.personaHead': { rules: [{ id: 'h', enabled: true, text: '头：{{model}} / {{provider}}', models: { all: true, list: [] } }] },
  'system.personaTail': { rules: [] },
  'system.middle': { rules: [{ id: 'm', enabled: true, text: '拼错的 {{modle}} 与中文 {{中文}} 都原样', models: { all: true, list: [] } }] },
}
const readConfig = async () => ({ revision: 1, slots })
registerSystemSections(root, readConfig, () => {})
await new Promise((resolve) => setTimeout(resolve, 0))

const agent = {
  options: { provider: 'deepseek-account', model: 'deepseek-flash' },
  session: { header: { cwd: 'D:\\repo' } },
}

// ---------- 有 agent：官方渲染器真跑一遍 ----------
const assembly = await root.systemPrompt.assemble({ agent })
const prompt = renderPrompt(assembly)
check('中间锚点里的 {{cwd}} / {{model}} 落位', prompt.includes('工具说明之前 @ D:\\repo（deepseek-flash）'), prompt.slice(0, 400))
check('改写的官方头里 {{model}} / {{provider}} 落位', prompt.includes('头：deepseek-flash / deepseek-account'))
check('没配改写的官方尾仍由官方自己渲染（{{cwd}} 不能留成字面）', prompt.includes('Your working directory is D:\\repo.'))
check('认不出的字段与中文花括号原样留在正文里', prompt.includes('拼错的 {{modle}} 与中文 {{中文}} 都原样'))
check('整篇提示词里没有残留的可渲染变量（除了故意留的那两处）', (prompt.match(/\{\{/g) ?? []).length === 2, JSON.stringify(prompt.match(/\{\{[^}]*\}\}/g)))

const ourSections = assembly.sections.filter((section) => section.name.startsWith('prompt-inject:') || section.name === 'deployment:persona-prefix')
check('插件碰过的段都标了 interpolate=false', ourSections.every((section) => section.interpolate === false), ourSections.map((section) => `${section.name}:${section.interpolate}`).join(', '))
const officialTail = assembly.sections.find((section) => section.name === 'deployment:persona-suffix')
check('官方自己的段没被标 interpolate=false（它还要靠官方插值）', officialTail.interpolate === undefined && officialTail.text === PERSONA_SUFFIX)

// ---------- 没 agent（标题/摘要这类内部调用）：不能炸，占位符原样留着 ----------
const bare = await root.systemPrompt.assemble({})
check('没有 agent 时插件渲染的段把没有值的字段原样留着', bare.sections.find((section) => section.name === 'prompt-inject:beforeTools')?.text === '工具说明之前 @ {{cwd}}（{{model}}）', bare.sections.find((section) => section.name === 'prompt-inject:beforeTools')?.text)
check('没有 agent 时官方段原样返回', bare.sections.find((section) => section.name === 'deployment:persona-suffix')?.text === PERSONA_SUFFIX)

// ---------- 全都不配：system 与装插件前逐字一致 ----------
const plain = new Context()
await plain.plugin(SystemPrompt, { personaPrefix: PERSONA_PREFIX, personaSuffix: PERSONA_SUFFIX })
plain.systemPrompt.variable('model', (context) => context.agent?.options.model)
plain.systemPrompt.variable('cwd', (context) => context.agent?.session.header.cwd)
registerSystemSections(plain, async () => ({ revision: 1, slots: {} }), () => {})
await new Promise((resolve) => setTimeout(resolve, 0))
const untouched = renderPrompt(await plain.systemPrompt.assemble({ agent }))
check('一条规则都不配时，官方头尾逐字保留', untouched.includes(PERSONA_PREFIX.replace('{{model}}', 'deepseek-flash')) && untouched.includes(PERSONA_SUFFIX.replace('{{cwd}}', 'D:\\repo')), untouched)

const failed = results.filter((item) => item.ok !== true)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const item of failed) console.log('  - ' + item.name)
  process.exitCode = 1
}

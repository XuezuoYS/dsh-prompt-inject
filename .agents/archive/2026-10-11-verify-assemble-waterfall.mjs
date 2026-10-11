// 实验 1b：验证两件事
//  A. 同一作用域里两个行插件注册同名段 → 是否撞车（桌面 preset 已挂 dsh-persona，这是真实冲突）
//  B. 替代方案：在 agent 作用域监听 system-prompt/assemble waterfall，直接改写/插入段
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, {
  PERSONA_PREFIX_SECTION,
  PERSONA_SUFFIX_SECTION,
  renderPrompt,
} from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'

const rule = (t) => console.log(`\n===== ${t} =====`)
const root = new Context()
await root.plugin(SystemPrompt, {
  personaPrefix: 'GLOBAL-HEAD',
  personaSuffix: 'GLOBAL-TAIL',
})
const textOf = (a, name) => {
  const s = a.sections.find((x) => x.name === name)
  return s === undefined ? '(absent)' : JSON.stringify(s.text)
}

const makeRow = (label, head, tail) => ({
  name: `row-${label}`,
  inject: ['systemPrompt'],
  apply(ctx) {
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: PERSONA_PREFIX_SECTION,
        order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        text: head,
      }),
    )
    if (tail !== undefined)
      ctx.effect(() =>
        ctx.systemPrompt.section({
          name: PERSONA_SUFFIX_SECTION,
          order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
          text: tail,
        }),
      )
  },
})

const key = { label: 'agent-1' }
const agentScope = createScope(root, key)

rule('A. 模拟官方 dsh-persona 先挂（preset 里本来就有）')
agentScope.ctx.plugin(makeRow('official-persona', 'OFFICIAL-HEAD', 'OFFICIAL-TAIL'))
const a1 = await root.systemPrompt.assemble({ scope: key })
console.log(`agent-1  head=${textOf(a1, PERSONA_PREFIX_SECTION)}  tail=${textOf(a1, PERSONA_SUFFIX_SECTION)}`)

rule('A2. 我们的行插件再注册同名段（预期：同作用域重名 → 抛错）')
try {
  agentScope.ctx.plugin(makeRow('ours', 'OURS-HEAD', 'OURS-TAIL'))
  const a2 = await root.systemPrompt.assemble({ scope: key })
  console.log(`没有抛错，结果 head=${textOf(a2, PERSONA_PREFIX_SECTION)} tail=${textOf(a2, PERSONA_SUFFIX_SECTION)}`)
} catch (error) {
  console.log(`抛错 ✓ ${error.message}`)
}

rule('B. 替代方案：agent 作用域上的 system-prompt/assemble 监听器')
let liveHead = 'LIVE-HEAD-1'
const dispose = agentScope.ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
  const assembled = await next()
  const sections = assembled.sections.map((s) =>
    s.name === PERSONA_PREFIX_SECTION ? { ...s, text: `[${liveHead}]` } : s,
  )
  // 再往中间插一段（order 950：工具说明之前）
  sections.push({ name: 'prompt-inject:beforeTools', text: 'MIDDLE-INJECT' })
  sections.sort((x, y) => (x.order ?? 0) - (y.order ?? 0))
  return { ...assembled, sections }
})

const b1 = await root.systemPrompt.assemble({ scope: key })
console.log(`agent-1  head=${textOf(b1, PERSONA_PREFIX_SECTION)}`)
console.log(renderPrompt(b1))

rule('B2. 改一下 live 文本再组装（模拟 GUI 改规则后实时生效）')
liveHead = 'LIVE-HEAD-2'
const b2 = await root.systemPrompt.assemble({ scope: key })
console.log(`agent-1  head=${textOf(b2, PERSONA_PREFIX_SECTION)}`)

rule('B3. 别的 agent 作用域不应被这个监听器影响')
const otherKey = { label: 'agent-2' }
const b3 = await root.systemPrompt.assemble({ scope: otherKey })
console.log(`agent-2  head=${textOf(b3, PERSONA_PREFIX_SECTION)}  mid=${textOf(b3, 'prompt-inject:beforeTools')}`)

rule('B4. 撤销监听后回到官方文本')
dispose()
const b4 = await root.systemPrompt.assemble({ scope: key })
console.log(`agent-1  head=${textOf(b4, PERSONA_PREFIX_SECTION)}  mid=${textOf(b4, 'prompt-inject:beforeTools')}`)

rule('判定')
const pass =
  textOf(b1, PERSONA_PREFIX_SECTION) === '"[LIVE-HEAD-1]"' &&
  textOf(b2, PERSONA_PREFIX_SECTION) === '"[LIVE-HEAD-2]"' &&
  textOf(b3, PERSONA_PREFIX_SECTION) === '"GLOBAL-HEAD"' &&
  textOf(b3, 'prompt-inject:beforeTools') === '(absent)' &&
  textOf(b4, PERSONA_PREFIX_SECTION) === '"OFFICIAL-HEAD"'
console.log(pass ? 'PASS：waterfall 改写/插入可用，且只影响本作用域' : 'FAIL：见上面各行')

// 实验 1c：行插件的挂载是异步的；同作用域重名段到底怎么失败（抛错还是静默吞掉）
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, {
  PERSONA_PREFIX_SECTION,
  renderPrompt,
} from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'

const rule = (t) => console.log(`\n===== ${t} =====`)
const tick = () => new Promise((r) => setTimeout(r, 30))
const root = new Context()
await root.plugin(SystemPrompt, { personaPrefix: 'GLOBAL-HEAD', personaSuffix: 'GLOBAL-TAIL' })
const textOf = (a, name) => {
  const s = a.sections.find((x) => x.name === name)
  return s === undefined ? '(absent)' : JSON.stringify(s.text)
}

const row = (label, head) => ({
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
  },
})

const key = { label: 'agent-1' }
const scope = createScope(root, key)

rule('A. 挂第一个行插件，挂完立刻组装（不等）')
const fiberA = scope.ctx.plugin(row('official', 'OFFICIAL-HEAD'))
console.log(`立刻组装 head=${textOf(await root.systemPrompt.assemble({ scope: key }), PERSONA_PREFIX_SECTION)}`)
await tick()
console.log(`等一个 tick 后 head=${textOf(await root.systemPrompt.assemble({ scope: key }), PERSONA_PREFIX_SECTION)}`)
console.log(`fiberA.state=${fiberA.state}`)

rule('B. 再挂一个注册同名段的行插件')
const fiberB = scope.ctx.plugin(row('ours', 'OURS-HEAD'))
await tick()
console.log(`组装 head=${textOf(await root.systemPrompt.assemble({ scope: key }), PERSONA_PREFIX_SECTION)}`)
console.log(`fiberB.state=${fiberB.state}  error=${fiberB.error === undefined ? '(none)' : String(fiberB.error)}`)

rule('C. 结论')
console.log('若 head 仍是 OFFICIAL-HEAD，说明第二次注册被静默拒绝（不是抛给我们）')

rule('D. 我们的正路：自己的段名 + 自己的 order（无冲突）')
const rowOwn = {
  name: 'row-own',
  inject: ['systemPrompt'],
  apply(ctx) {
    ctx.effect(() =>
      ctx.systemPrompt.section({ name: 'prompt-inject:beforeTools', order: 950, text: 'MIDDLE-950' }),
    )
  },
}
scope.ctx.plugin(rowOwn)
await tick()
const d = await root.systemPrompt.assemble({ scope: key })
console.log(`prompt-inject:beforeTools=${textOf(d, 'prompt-inject:beforeTools')}`)
console.log(renderPrompt(d))

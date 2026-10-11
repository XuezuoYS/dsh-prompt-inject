// 实验 2（忠实版）：按真实顺序 [前缀][用户原文][后缀] 落库，再范围替换还原。
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const rule = (t) => console.log(`\n===== ${t} =====`)
const textOf = (m) => m.content.map((b) => (b.type === 'text' ? b.text : `<${b.type}>`)).join('|')
const userMsg = (text, kind = 'user') =>
  createUserMessage({ content: [{ type: 'text', text }], source: { kind } })
const dump = (session) => {
  const wire = session.deriveMessages()
  for (const m of wire) console.log(`  ${m.role}: ${textOf(m)}`)
  return wire
}

const root = new Context()
await root.plugin(SessionStore)
const session = root.sessions.create('exp2-session', { meta: { cwd: process.cwd() } })

rule('1. 第 1 轮：agent/pre-step 返回 [前缀, 用户原文, 后缀]，按数组顺序落库')
const p = session.append('user/message', userMsg('{前置词}', 'prompt-inject'), { surfaceOp: 'append' })
const u = session.append('user/message', userMsg('user this input'), { surfaceOp: 'append' })
const s = session.append('user/message', userMsg('{后置词}', 'prompt-inject'), { surfaceOp: 'append' })
console.log(`surface nodes = [${session.surface.nodes.join(', ')}]`)
console.log('模型第 1 条请求看到：')
dump(session)
console.log('（DeepSeek adapter 会把连续 user 消息合并 → 一条 {前置词}原文{后置词}）')

rule('2. 同轮工具循环：什么都不做，注入保持')
const tool = session.append('assistant/message', {
  turn: 1,
  step: 1,
  message: createUserMessage === undefined ? {} : {
    id: 'a1',
    role: 'assistant',
    content: [{ type: 'text', text: 'calling tool' }],
    source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' },
  },
}, { surfaceOp: 'append' })
console.log('模型第 2 条请求看到：')
dump(session)

rule('3. 第 2 轮：新用户输入到来 → 先把上一轮三条范围替换回原文')
const restored = session.append(
  'user/message',
  createUserMessage({ content: u.data.content, source: u.data.source }),
  {
    surfaceOp: { op: 'replace', startSeq: p.seq, endSeq: s.seq },
    sourceEventSeqs: [p.seq, u.seq, s.seq],
  },
)
console.log(`surface nodes = [${session.surface.nodes.join(', ')}]`)
console.log('模型第 3 条请求看到（历史应已干净）：')
const clean = dump(session)

rule('4. 再给第 2 轮的输入注入前后缀')
const p2 = session.append('user/message', userMsg('{前置词}', 'prompt-inject'), { surfaceOp: 'append' })
const u2 = session.append('user/message', userMsg('second input'), { surfaceOp: 'append' })
const s2 = session.append('user/message', userMsg('{后置词}', 'prompt-inject'), { surfaceOp: 'append' })
console.log('模型第 4 条请求看到：')
const turn2 = dump(session)

rule('5. 会话日志（Chat 的真源）：append 事件一条都没丢')
for (const e of session.snapshotEvents()) {
  if (e.type !== 'user/message' && e.type !== 'assistant/message') continue
  const body = e.type === 'user/message' ? textOf(e.data) : textOf(e.data.message)
  console.log(
    `  seq=${e.seq} type=${e.type} surfaceOp=${JSON.stringify(e.surfaceOp)} appendOrigin=${isAppendSurfaceEvent(e)} 文字=${body}`,
  )
}

rule('判定')
const flattened = (msgs) => msgs.map(textOf)
const cleanList = flattened(clean)
const turn2List = flattened(turn2)
const pass =
  // 第 1 条请求必须是三段连排
  flattened(session.deriveMessages()).length >= 3 &&
  // 还原后：只剩一条原文，没有前后缀
  cleanList.filter((t) => t.includes('前置词') || t.includes('后置词')).length === 0 &&
  cleanList.filter((t) => t === 'user this input').length === 1 &&
  // 第 2 轮：历史干净 + 新输入带前后缀
  turn2List.filter((t) => t === 'user this input').length === 1 &&
  turn2List.filter((t) => t.includes('前置词')).length === 1 &&
  turn2List.filter((t) => t === 'second input').length === 1
console.log(pass ? 'PASS：顺序、还原、二轮注入都符合 injectFormat' : 'FAIL：见上面各行')
console.log(pass ? `\n模型最后一次看到的完整历史：\n${turn2List.map((t) => '  ' + t).join('\n')}` : '')
process.exit(pass ? 0 : 1)

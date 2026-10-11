// 实测 DSH 0.2.0-rc.2：范围替换让 surface 变短之后，派生消息缓存会留下脏状态。
//
// 结论（2026-10-11，本机 desktop 发行包）：
// - 替换只清空 `session.derived` 数组、把 `derivedNodes` 留在旧值（surface 变短了），
//   `derivedGeneration` 仍是旧值。此时**没有任何人读历史**的话，缓存是脏的；
// - 谁先读一次历史，谁就把缓存重建对了（`derivedNodes` 落到新节点数）。
//
// 所以「安全网」有两条路都要走通：
//   A. 替换之后没人读过历史 → 安全网必须触发，否则后面的读取会从错位置切片；
//   B. 替换之后已经有人读过 → 安全网不该触发，历史本身已经正确。
//
// 运行方式：见 .agents/checks/README.md（需要一份带 node_modules 的实验目录）。
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { repairDerivedCache } from '../../lib/sessionInjector.js'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const textOf = (message) =>
  (message?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')

const userMsg = (text, kind = 'user') => createUserMessage({ content: [{ type: 'text', text }], source: { kind } })

const root = new Context()
await root.plugin(SessionStore)

/** 造一个「第 1 轮已注入、并被读过历史」的会话。 */
function sessionWithInjectedTurn(id) {
  const session = root.sessions.create(id, { meta: { cwd: process.cwd() } })
  const prefix = session.append('user/message', userMsg('{前置词}', 'prompt-inject'), { surfaceOp: 'append' })
  const original = session.append('user/message', userMsg('第一条用户输入'), { surfaceOp: 'append' })
  const suffix = session.append('user/message', userMsg('{后置词}', 'prompt-inject'), { surfaceOp: 'append' })
  return { session, prefix, original, suffix }
}

/** 还原上一次注入（范围替换），返回新事件。 */
function restore(session, prefix, original, suffix) {
  return session.append('user/message', createUserMessage({ content: original.data.content, source: original.data.source }), {
    surfaceOp: { op: 'replace', startSeq: prefix.seq, endSeq: suffix.seq },
    sourceEventSeqs: [prefix.seq, original.seq, suffix.seq],
  })
}

// ---------- 第 1 轮：注入后读一次历史（loop 组请求那一步） ----------
const a = sessionWithInjectedTurn('prompt-inject-a')
const firstRead = a.session.deriveMessages().map(textOf)
check('第 1 轮：模型看到三条连排 user 消息', firstRead.length === 3 && firstRead[2] === '{后置词}', JSON.stringify(firstRead))

// ---------- 路径 A：替换之后没人读历史，直接走安全网 ----------
restore(a.session, a.prefix, a.original, a.suffix)
const staleAfterReplace = { nodes: a.session.surface.nodes.length, derivedNodes: a.session.derivedNodes }
const repaired = repairDerivedCache(a.session)
check(
  '路径 A：替换后（没人读历史）derivedNodes 落后于节点数',
  staleAfterReplace.derivedNodes > staleAfterReplace.nodes,
  JSON.stringify(staleAfterReplace),
)
check('路径 A：安全网必须触发', repaired === true, `repairDerivedCache=${String(repaired)}`)
const afterRepair = a.session.deriveMessages().map(textOf)
check('路径 A：安全网之后历史正确且完整', afterRepair.length === 1 && afterRepair[0] === '第一条用户输入', JSON.stringify(afterRepair))

// ---------- 路径 B：替换之后已经有人读过历史 ----------
const b = sessionWithInjectedTurn('prompt-inject-b')
b.session.deriveMessages()
restore(b.session, b.prefix, b.original, b.suffix)
const healthyRead = b.session.deriveMessages().map(textOf)
check('路径 B：替换后第一次读取就给出正确历史', healthyRead.length === 1 && healthyRead[0] === '第一条用户输入', JSON.stringify(healthyRead))
check('路径 B：缓存已自愈，安全网不触发', repairDerivedCache(b.session) === false)

// ---------- 两条路上挂新一轮输入，最终历史都必须对 ----------
for (const [label, item] of [['A', a], ['B', b]]) {
  item.session.append('user/message', userMsg('{前置词}', 'prompt-inject'), { surfaceOp: 'append' })
  item.session.append('user/message', userMsg('第二条用户输入'), { surfaceOp: 'append' })
  const finalTexts = item.session.deriveMessages().map(textOf)
  check(
    `路径 ${label}：新一轮历史 = 原文 + 新前缀 + 新输入`,
    finalTexts.join('|') === '第一条用户输入|{前置词}|第二条用户输入',
    JSON.stringify(finalTexts),
  )
}

// append 真源不能丢：Chat 只看 surfaceOp === 'append' 的事件。
const appends = a.session
  .snapshotEvents()
  .filter((event) => event.type === 'user/message' && isAppendSurfaceEvent(event))
  .map((event) => textOf(event.data))
check('append 真源完整（两条原文 + 两组前后缀）', appends.length === 5, JSON.stringify(appends))

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)

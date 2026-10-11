// 把一个会话日志的 surface 还原出来：按事件重放 surfaceOp（append / replace），
// 打印每个存活节点的 seq、角色、source.kind+turn、文本。
// 用法：node dump-surface.mjs <session.v4.jsonl.zstd> [只看第几条起]
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const [, , input, fromArg] = process.argv
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const buffer = readFileSync(input)
const parts = []
let at = buffer.indexOf(magic)
while (at !== -1) {
  try {
    parts.push(zstdDecompressSync(buffer.subarray(at)).toString('utf8'))
  } catch {}
  at = buffer.indexOf(magic, at + 1)
}
const docs = parts
  .join('')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return undefined
    }
  })
  .filter(Boolean)

const textOf = (data) =>
  (data?.content ?? [])
    .map((block) => (block?.type === 'text' ? block.text : `[${block?.type}]`))
    .join(' ')

/** 重放一份 surface。 */
function surfaceAt(upToSeq) {
  const nodes = []
  for (const event of docs) {
    if (event.seq === undefined) continue
    if (upToSeq !== undefined && event.seq > upToSeq) break
    const op = event.surfaceOp
    if (op === undefined) continue
    if (op === 'append') {
      nodes.push(event.seq)
      continue
    }
    if (typeof op !== 'object') continue
    if (op.op === 'replace') {
      const start = nodes.indexOf(op.startSeq)
      const end = nodes.indexOf(op.endSeq)
      if (start === -1 || end === -1) continue
      nodes.splice(start, end - start + 1, event.seq)
      continue
    }
    if (op.op === 'remove') {
      const start = nodes.indexOf(op.startSeq)
      const end = nodes.indexOf(op.endSeq)
      if (start === -1 || end === -1) continue
      nodes.splice(start, end - start + 1)
    }
  }
  return nodes
}

const from = Number(fromArg ?? 0)
const events = new Map(docs.filter((event) => event.seq !== undefined).map((event) => [event.seq, event]))

// 所有范围替换事件（谁把谁抹掉了）
console.log('===== replace 事件')
for (const event of docs) {
  if (typeof event.surfaceOp !== 'object' || event.surfaceOp?.op !== 'replace') continue
  console.log(
    `  seq ${String(event.seq).padStart(5)} [${event.data?.source?.kind ?? '?'}${event.data?.source?.turn === undefined ? '' : `#${event.data.source.turn}`}${event.data?.source?.dropped === true ? ' dropped' : ''}] replace ${event.surfaceOp.startSeq}..${event.surfaceOp.endSeq} :: ${textOf(event.data).replace(/\n/g, '\\n').slice(0, 40)}`,
  )
}

// 找出 turn/start 的位置，逐个 turn 打印 surface 快照
const turns = docs.filter((event) => event.type === 'turn/start')
for (const turn of turns) {
  if (turn.data.turn < from) continue
  const nodes = surfaceAt(turn.seq)
  console.log(`\n===== TURN ${turn.data.turn} 开始时的 surface（${nodes.length} 个节点）`)
  for (const seq of nodes) {
    const event = events.get(seq)
    const kind = event?.data?.source?.kind ?? '?'
    const turnMark = event?.data?.source?.turn === undefined ? '' : `#${event.data.source.turn}`
    const dropped = event?.data?.source?.dropped === true ? ' dropped' : ''
    console.log(`  seq ${String(seq).padStart(5)} ${(event?.type ?? '?').padEnd(14)} [${kind}${turnMark}${dropped}] ${textOf(event?.data).replace(/\n/g, '\\n').slice(0, 70)}`)
  }
}

if (fromArg === 'last') {
  const nodes = surfaceAt(undefined)
  console.log(`\n===== 会话结束时的 surface（${nodes.length} 个节点）`)
  for (const seq of nodes) {
    const event = events.get(seq)
    const kind = event?.data?.source?.kind ?? '?'
    const turnMark = event?.data?.source?.turn === undefined ? '' : `#${event.data.source.turn}`
    const dropped = event?.data?.source?.dropped === true ? ' dropped' : ''
    console.log(`  seq ${String(seq).padStart(5)} ${(event?.type ?? '?').padEnd(14)} [${kind}${turnMark}${dropped}] ${textOf(event?.data).replace(/\n/g, '\\n').slice(0, 70)}`)
  }
}

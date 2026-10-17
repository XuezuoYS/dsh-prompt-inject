// 按 seq 区间原样 dump 会话事件（临时排查用）。
// 用法：node .agents/archive/2026-10-12-dump-session-range.mjs <session.v4.jsonl.zstd> <fromSeq> <toSeq> [最大字符数]
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const [, , input, fromSeq, toSeq, maxChars = '600'] = process.argv
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

const from = Number(fromSeq)
const to = Number(toSeq)
for (const event of docs) {
  if (event.seq < from || event.seq > to) continue
  const json = JSON.stringify(event)
  console.log(`--- seq ${event.seq} ${event.type}`)
  console.log(json.length > Number(maxChars) ? `${json.slice(0, Number(maxChars))}…` : json)
}

// 读一份 DSH 会话日志，打印「路由 / 注入 / 用户消息」的时间线。
//
// 为什么要它：会话日志是 `.jsonl.zstd`，而且是**多帧拼接**的（每次 append 一帧），
// Node 的 `zstdDecompressSync` 只解第一帧。真机上「这轮算的哪个模型、注入了什么」只能靠它核对：
//   node .agents/checks/read-session.mjs "$env:USERPROFILE\.dsh\sessions\<工作区>\<会话>\session.v4.jsonl.zstd"
// 时间线里 CTX=request/context（已提交的路由）、SEL=model/selection（用户点下拉）、
// HDR=request/header、INJ/USR=用户消息（带 source.kind）。
//
// 用法：node .agents/checks/read-session.mjs <session.v4.jsonl.zstd> [摘要|时间线]
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const [, , input, mode = '时间线'] = process.argv
if (input === undefined) {
  console.error('用法：node .agents/checks/read-session.mjs <session.v4.jsonl.zstd> [摘要|时间线]')
  process.exit(2)
}

/** 按 zstd 魔数切帧，逐帧解（拼起来的每一帧都是完整的一行 JSON）。 */
function readSessionFrames(buffer) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const parts = []
  let at = buffer.indexOf(magic)
  while (at !== -1) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(at)).toString('utf8'))
    } catch {
      // 压缩数据里凑巧出现的魔数：跳过。
    }
    at = buffer.indexOf(magic, at + 1)
  }
  return parts.join('')
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (part?.type === 'text' ? part.text : `[${part?.type}]`)).join(' ')
  return ''
}

const docs = readSessionFrames(readFileSync(input))
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

if (mode === '摘要') {
  const types = new Map()
  const kinds = new Map()
  for (const event of docs) {
    types.set(event.type, (types.get(event.type) ?? 0) + 1)
    if (event.type === 'user/message') {
      const kind = event.data?.source?.kind ?? '(none)'
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
    }
  }
  console.log(`事件 ${docs.length} 条`)
  for (const [type, count] of [...types.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${count}\t${type}`)
  console.log('user/message 的 source.kind：')
  for (const [kind, count] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${count}\t${kind}`)
} else {
  for (const event of docs) {
    const data = event.data ?? {}
    const seq = event.seq
    if (event.type === 'turn/start') console.log(`${seq}\tTURN ${data.turn}`)
    else if (event.type === 'request/context') console.log(`${seq}\tCTX  ${data.provider}/${data.model}`)
    else if (event.type === 'request/header') console.log(`${seq}\tHDR  ${data.header?.config?.provider}/${data.header?.config?.model} (${data.reason ?? ''})`)
    else if (event.type === 'model/selection') console.log(`${seq}\tSEL  ${data.provider}/${data.model}`)
    else if (event.type === 'compaction/start' || event.type === 'compaction/end') console.log(`${seq}\t${event.type.toUpperCase()}`)
    else if (event.type === 'user/message') {
      const kind = data.source?.kind ?? '(none)'
      const text = textOf(data.content).slice(0, 80).replace(/\n/g, '\\n')
      console.log(`${seq}\t${kind === 'prompt-inject' ? 'INJ ' : 'USR '}\t[${kind}] ${text}`)
    }
  }
}

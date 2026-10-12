/**
 * 临时探针：在发行包 app.asar 的文本里查若干关键字并打印上下文。
 * 用法：ASAR=<asar路径> node .agents/archive/2026-10-12-asar-scan.mjs 关键字1 关键字2 ...
 * 不给 ASAR 时按 Windows 桌面版默认安装位置找；别的系统/自定义目录请显式给 ASAR。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const asarPath =
  process.env.ASAR ??
  (process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar')
    : null)
if (asarPath === null) {
  console.error('找不到发行包：请用 ASAR=<app.asar 路径> 指定（Windows 桌面版默认在 %LOCALAPPDATA%\\Programs\\DeepSeek Harness\\resources\\app.asar）')
  process.exit(1)
}
const text = readFileSync(asarPath, 'utf8')
const limit = Number(process.env.LIMIT ?? 6)
const before = Number(process.env.BEFORE ?? 260)
const after = Number(process.env.AFTER ?? 260)

for (const key of process.argv.slice(2)) {
  let index = -1
  let count = 0
  while ((index = text.indexOf(key, index + 1)) >= 0 && count < limit) {
    count += 1
    console.log(`=== ${key} @ ${index}`)
    console.log(JSON.stringify(text.slice(Math.max(0, index - before), index + after)))
  }
  console.log(`--- ${key}: shown ${count}`)
}

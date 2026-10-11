/**
 * 临时探针：在发行包 app.asar 的文本里查若干关键字并打印上下文。
 * 用法：node .agents/scan-asar.mjs 关键字1 关键字2 ...
 */
import { readFileSync } from 'node:fs'

const asarPath = 'C:/Users/xuezu/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
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

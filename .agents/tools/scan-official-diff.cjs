// 对比两棵解包出来的官方包树，列出新增 / 删除 / 改动的文件。升级 dsh 时先跑它圈定范围。
// 用法：node .agents/tools/scan-official-diff.cjs <旧树> <新树> [包名子串过滤...]
const fs = require('node:fs')
const path = require('node:path')

const [, , oldRoot, newRoot, ...filters] = process.argv
if (!oldRoot || !newRoot) {
  console.error('用法：node scan-diff.cjs <旧树> <新树> [包名过滤...]')
  process.exit(2)
}

/** 递归收集文件（相对路径 -> 大小）。跳过 node_modules 和 .map。 */
function walk(root) {
  const out = new Map()
  ;(function rec(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.name === 'node_modules') continue
      const full = path.join(dir, item.name)
      if (item.isDirectory()) rec(full)
      else if (item.isFile()) out.set(path.relative(root, full).replaceAll('\\', '/'), fs.statSync(full).size)
    }
  })(root)
  return out
}

const oldFiles = walk(oldRoot)
const newFiles = walk(newRoot)
const all = new Set([...oldFiles.keys(), ...newFiles.keys()])

/** 文件是否落在关注的包里。 */
function wanted(file) {
  if (filters.length === 0) return true
  return filters.some((f) => file.startsWith(`${f}/`) || file.includes(`/${f}/`))
}

function content(p) {
  try {
    return fs.readFileSync(p)
  } catch {
    return null
  }
}

const added = []
const removed = []
const changed = []
for (const file of [...all].sort()) {
  if (!wanted(file)) continue
  if (/\.map$/.test(file)) continue
  const a = oldFiles.get(file)
  const b = newFiles.get(file)
  if (a === undefined) added.push(file)
  else if (b === undefined) removed.push(file)
  else if (a !== b) changed.push(file)
  else {
    const ca = content(path.join(oldRoot, file))
    const cb = content(path.join(newRoot, file))
    if (!ca || !cb || !ca.equals(cb)) changed.push(file)
  }
}

console.log(`## 新增（${added.length}）`)
for (const f of added) console.log(`+ ${f}`)
console.log(`\n## 删除（${removed.length}）`)
for (const f of removed) console.log(`- ${f}`)
console.log(`\n## 改动（${changed.length}）`)
for (const f of changed) console.log(`~ ${f}`)

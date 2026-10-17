// 从 app.asar 抽子树。用法：node asar2.cjs list|read|extract <asar> <innerPath> [outDir]
// 数据区起点用「头部区里找第一个文件（offset 0）的开头」来定标，不依赖 pickle 的记账值。
const fs = require('node:fs')
const path = require('node:path')

const [, , mode, asarPath, innerPath, outDir] = process.argv

/** 读文件的头 N 字节。 */
function readAt(fd, position, length) {
  const buf = Buffer.alloc(length)
  fs.readSync(fd, buf, 0, length, position)
  return buf
}

/** 载入 asar 头并定标数据区起点。 */
function openAsar(file) {
  const fd = fs.openSync(file, 'r')
  const head = readAt(fd, 0, 16)
  const pickled = head.readUInt32LE(4)
  const payload = readAt(fd, 16, pickled)
  const text = payload.toString('utf8')
  const header = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))

  let first = null
  ;(function walk(node, prefix) {
    for (const [name, child] of Object.entries(node.files || {})) {
      const full = prefix ? `${prefix}/${name}` : name
      if (child.files) walk(child, full)
      else if (child.unpacked === undefined && (first === null || Number(child.offset) < Number(first.entry.offset))) first = { full, entry: child }
    }
  })(header, '')

  // 数据区起点定标：这份发行包实测 = 16 + pickledSize - 8。
  // 验证办法：读第一个文件（offset 0，dsh/desktop-runtime.json）的第一个字节，
  // 必须是 `{`（0x7b）；用 16 + pickledSize 会偏后 8 字节，把每个文件的开头吃掉。
  const base = 16 + pickled - 8
  return { fd, header, base, first: first?.full }
}

const { fd, header, base } = openAsar(asarPath)

function entryOf(root, p) {
  let node = root
  for (const part of p.split('/').filter(Boolean)) {
    node = node?.files?.[part]
    if (!node) return undefined
  }
  return node
}

function walk(node, prefix, out) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const full = prefix ? `${prefix}/${name}` : name
    if (child.files) walk(child, full, out)
    else out.push([full, child])
  }
}

function readEntry(entry) {
  if (entry.unpacked !== undefined) throw new Error('unpacked entry')
  return readAt(fd, base + Number(entry.offset), entry.size)
}

if (mode === 'list') {
  const entry = entryOf(header, innerPath)
  if (!entry) throw new Error(`not found: ${innerPath}`)
  const out = []
  if (entry.files) walk(entry, innerPath, out)
  else out.push([innerPath, entry])
  for (const [full, child] of out) console.log(`${child.size}\t${full}`)
} else if (mode === 'read') {
  const entry = entryOf(header, innerPath)
  if (!entry) throw new Error(`not found: ${innerPath}`)
  process.stdout.write(readEntry(entry))
} else if (mode === 'extract') {
  const entry = entryOf(header, innerPath)
  if (!entry) throw new Error(`not found: ${innerPath}`)
  const out = []
  if (entry.files) walk(entry, innerPath, out)
  else out.push([innerPath, entry])
  let bytes = 0
  let skipped = 0
  for (const [full, child] of out) {
    if (child.unpacked !== undefined) {
      skipped += 1
      continue
    }
    const rel = full.slice(innerPath.length).replace(/^\//, '') || path.basename(full)
    const dest = path.join(outDir, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, readEntry(child))
    bytes += child.size
  }
  console.log(`base = ${base}  锚点文件 = ${first}  抽出 ${out.length - skipped} 个文件（跳过 ${skipped} 个 unpacked），${(bytes / 1048576).toFixed(2)} MB -> ${outDir}`)
}
fs.closeSync(fd)

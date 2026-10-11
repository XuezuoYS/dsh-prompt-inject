// 把 app.asar 里指定的子树抽到磁盘上（临时工具）。
// 用法：node asar-extract.cjs <asar 路径> <asar 内子路径，如 dsh/lib> <输出目录>
const fs = require('node:fs')
const path = require('node:path')

const [, , asarPath, innerPath, outDir] = process.argv
if (!asarPath || !innerPath || !outDir) {
  console.error('usage: node asar-extract.cjs <asar> <innerPath> <outDir>')
  process.exit(1)
}

const fd = fs.openSync(asarPath, 'r')
// 头部是 Electron 的 pickle：4 字节“4” + 4 字节 pickledSize，pickledSize 里还含
// 4 字节 headerStringSize 与 4 字节尾部 padding，所以 JSON 长度 = pickledSize - 8。
const sizeBuf = Buffer.alloc(16)
fs.readSync(fd, sizeBuf, 0, 16, 0)
const headerJsonSize = sizeBuf.readUInt32LE(8) - 8
console.log('headerJsonSize =', headerJsonSize, 'pickled =', sizeBuf.readUInt32LE(4))
const headerBuf = Buffer.alloc(headerJsonSize)
fs.readSync(fd, headerBuf, 0, headerJsonSize, 16)
const header = JSON.parse(headerBuf.toString('utf8'))
const baseOffset = 16 + sizeBuf.readUInt32LE(4)
console.log('baseOffset =', baseOffset, 'root keys =', Object.keys(header))

function walk(node, prefix, visit) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const full = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, full, visit)
    else visit(full, entry)
  }
}

let count = 0
let bytes = 0
walk(header, '', (full, entry) => {
  if (entry.unpacked) return
  if (!full.startsWith(innerPath)) return
  const rel = full.slice(innerPath.length).replace(/^\//, '')
  if (rel === '') return
  const dest = path.join(outDir, rel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const buf = Buffer.alloc(entry.size)
  fs.readSync(fd, buf, 0, entry.size, baseOffset + Number(entry.offset))
  fs.writeFileSync(dest, buf)
  count += 1
  bytes += entry.size
})
fs.closeSync(fd)
console.log(`extracted ${count} files, ${(bytes / 1048576).toFixed(1)} MB -> ${outDir}`)

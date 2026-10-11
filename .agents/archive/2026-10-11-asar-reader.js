// Minimal ASAR reader: list / extract paths (read-only usage).
// Usage:
//   node asar.js list  <archive> <prefix> [limit]
//   node asar.js tree  <archive> <prefix> [depth]
//   node asar.js cat   <archive> <innerPath>
//   node asar.js extract <archive> <prefix> <outDir>
const fs = require('fs');
const path = require('path');

function readHeader(archive) {
  const fd = fs.openSync(archive, 'r');
  // ASAR: [u32=4][u32=headerPickleSize][headerPickle: u32 payloadSize][u32 jsonLen][json...]
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const headerSize = head.readUInt32LE(4);
  const jsonLen = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  const baseOffset = 8 + headerSize;
  fs.closeSync(fd);
  return { header: JSON.parse(jsonBuf.toString('utf8')), baseOffset };
}

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (entry.files) walk(entry, p, out);
    else out.push({ path: p, size: entry.size, offset: Number(entry.offset), unpacked: !!entry.unpacked });
  }
}

function load(archive) {
  const { header, baseOffset } = readHeader(archive);
  const files = [];
  walk(header, '', files);
  return { baseOffset, files };
}

function readFile(archive, baseOffset, rec) {
  const fd = fs.openSync(archive, 'r');
  const buf = Buffer.alloc(rec.size);
  fs.readSync(fd, buf, 0, rec.size, baseOffset + rec.offset);
  fs.closeSync(fd);
  return buf;
}

const [cmd, archive, a1, a2] = process.argv.slice(2);
const { baseOffset, files } = load(archive);

if (cmd === 'list') {
  const limit = a2 ? Number(a2) : 400;
  const hits = files.filter((f) => f.path.startsWith(a1)).slice(0, limit);
  for (const h of hits) console.log(h.size + '\t' + h.path);
  console.log('--- total matched: ' + files.filter((f) => f.path.startsWith(a1)).length);
} else if (cmd === 'tree') {
  const depth = a2 ? Number(a2) : 2;
  const prefixLen = a1 ? a1.split('/').length : 0;
  const set = new Set();
  for (const f of files) {
    if (!f.path.startsWith(a1)) continue;
    const parts = f.path.split('/');
    if (parts.length - prefixLen > depth) continue;
    set.add(parts.slice(0, prefixLen + depth).join('/'));
  }
  for (const p of [...set].sort()) console.log(p);
} else if (cmd === 'cat') {
  const rec = files.find((f) => f.path === a1);
  if (!rec) { console.error('not found: ' + a1); process.exit(2); }
  process.stdout.write(readFile(archive, baseOffset, rec));
} else if (cmd === 'extract') {
  const outDir = a2;
  let n = 0, bytes = 0;
  for (const f of files) {
    if (!f.path.startsWith(a1)) continue;
    const dest = path.join(outDir, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (f.unpacked) continue;
    fs.writeFileSync(dest, readFile(archive, baseOffset, f));
    n++; bytes += f.size;
  }
  console.log('extracted ' + n + ' files, ' + (bytes / 1048576).toFixed(1) + ' MB');
} else {
  console.error('unknown command');
  process.exit(2);
}

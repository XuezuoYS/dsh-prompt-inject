// 配置读写的真实文件测试：在临时 DSH_HOME 里跑，不碰真实配置。
//
// 用法：node .agents/checks/verify-config-store.mjs
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'dsh-prompt-inject-home-'))
process.env.DSH_HOME = home

const { ConfigStore, CONFIG_FILE, emptySlots } = await import('../../lib/configStore.js')
const { validateSlots } = await import('../../lib/configValidation.js')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 造一条合法规则。 */
const rule = (id, text) => ({ id, enabled: true, text, models: { all: true, list: [] } })

check('配置文件落在 $DSH_HOME/dsh-prompt-inject/rules.json', CONFIG_FILE === join(home, 'dsh-prompt-inject', 'rules.json'), CONFIG_FILE)

// 1. 文件不存在时给空配置，revision 0，所有注入点都在。
const store = new ConfigStore()
const initial = await store.read()
check('首次读取：revision = 0', initial.revision === 0)
check('首次读取：所有注入点都在', Object.keys(initial.slots).length === 8, Object.keys(initial.slots).join(','))
check('首次读取：persona 头与尾是两个独立注入点', Array.isArray(initial.slots['system.personaHead'].rules) && Array.isArray(initial.slots['system.personaTail'].rules))
check('首次读取：没有 head/tail 嵌套形状', initial.slots['system.persona'] === undefined && initial.slots['system.personaHead'].head === undefined)

// 2. 写一次：revision +1，文件真的落盘。
const next = emptySlots()
next['user.prefix'].rules = [rule('r1', '总是用中文回答')]
const written = await store.write(next, 0)
check('写入后 revision = 1', written.revision === 1, String(written.revision))
const onDisk = JSON.parse(await readFile(CONFIG_FILE, 'utf8'))
check('文件内容与写入一致', onDisk.revision === 1 && onDisk.slots['user.prefix'].rules[0].text === '总是用中文回答')
check('文件带 version 字段', onDisk.version === 1)

// 3. 乐观锁：用过期的 revision 写会被拒，并带上服务端最新值。
let mismatch
try {
  await store.write(next, 0)
} catch (error) {
  mismatch = error
}
check('过期 revision 写入被拒（code=revision-mismatch）', mismatch?.code === 'revision-mismatch', String(mismatch?.code))
check('被拒时返回服务端最新 revision 与内容', mismatch?.revision === 1 && mismatch?.slots?.['user.prefix'].rules[0].text === '总是用中文回答')

// 4. 新实例（模拟重启）能读回同样的内容。
const reopened = new ConfigStore()
const reloaded = await reopened.read()
check('新实例读回 revision 1 与内容', reloaded.revision === 1 && reloaded.slots['user.prefix'].rules[0].text === '总是用中文回答')

// 5. 外部手改文件（换 mtime/内容）能被发现。
await writeFile(
  CONFIG_FILE,
  JSON.stringify({ version: 1, revision: 9, slots: { 'user.prefix': { rules: [rule('r9', '外部改的')] } } }, null, 2),
  'utf8',
)
const afterExternal = await reopened.read()
check('外部手改被发现并读回', afterExternal.revision === 9 && afterExternal.slots['user.prefix'].rules[0].text === '外部改的', `revision=${afterExternal.revision}`)
check('外部手改后缺失的注入点被补齐', Object.keys(afterExternal.slots).length === 8)

// 6. 坏文件：改名归档 + 空配置继续。
await writeFile(CONFIG_FILE, '{ this is not json', 'utf8')
const broken = new ConfigStore()
const recovered = await broken.read()
check('坏文件时给空配置（revision 0）', recovered.revision === 0 && recovered.slots['user.prefix'].rules.length === 0)
const files = await readdir(join(home, 'dsh-prompt-inject'))
check('坏文件被改名成 .bad 保留现场', files.some((name) => name.endsWith('.bad')), files.join(','))

// 7. 版本不认也走同一条路。
await writeFile(CONFIG_FILE, JSON.stringify({ version: 99, revision: 3, slots: {} }), 'utf8')
const wrongVersion = new ConfigStore()
const afterWrongVersion = await wrongVersion.read()
check('version 不认时给空配置', afterWrongVersion.revision === 0)
check('version 不认的文件也被归档', (await readdir(join(home, 'dsh-prompt-inject'))).filter((name) => name.endsWith('.bad')).length >= 2)

// 8. 校验层与写入配合：只给一部分注入点时自动补齐。
const partial = validateSlots({ 'user.prefix': { rules: [rule('x', 'x')] } })
check('只给一个注入点的请求会被补齐成完整 slots', partial.slots !== null && Object.keys(partial.slots).length === 8, JSON.stringify(partial.issues))
check('补齐后 persona 头与尾都在', Array.isArray(partial.slots?.['system.personaHead'].rules) && Array.isArray(partial.slots?.['system.personaTail'].rules))
const halfPersona = validateSlots({ 'system.personaHead': { rules: [rule('h', '头')] } })
check('只配头也能过，尾补空', halfPersona.slots?.['system.personaTail'].rules.length === 0, JSON.stringify(halfPersona.issues))

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
console.log(`（临时 DSH_HOME：${home}）`)
process.exit(failed.length === 0 ? 0 : 1)

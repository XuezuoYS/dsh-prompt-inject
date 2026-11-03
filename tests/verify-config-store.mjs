// 配置读写的真实文件测试：在临时 DSH_HOME 里跑，不碰真实配置。
//
// 结构版本 v2：`{ version: 2, revision, groups }`。新安装是**零组**（groups: []）；
// 老 v1 文件（`slots`）第一次被读到时复制一份 `rules.json.v1.bak`，在内存里迁成默认组，
// 用户下一次保存才落成 v2。
//
// 用法：node tests/verify-config-store.mjs
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'dsh-prompt-inject-home-'))
process.env.DSH_HOME = home

const { ConfigStore, CONFIG_FILE, LEGACY_BACKUP_FILE, emptyGroups } = await import('../lib/configStore.js')
const { DEFAULT_GROUP_ID, DEFAULT_GROUP_NAME, emptyPositions } = await import('../lib/groupConfig.js')
const { validateGroups } = await import('../lib/configValidation.js')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/**
 * 造一个完整组：没给的位置补默认块。
 * @param {string} id - 组 id。
 * @param {string} name - 组名。
 * @param {Record<string, { enabled: boolean, text: string }>} [positions] - 要覆盖的位置块。
 * @param {{ enabled?: boolean, models?: { all: boolean, list: string[] } }} [options] - 组级开关与作用域。
 * @returns {object} 组。
 */
const group = (id, name, positions = {}, options = {}) => ({
  id,
  name,
  enabled: options.enabled !== false,
  models: options.models ?? { all: true, list: [] },
  positions: { ...emptyPositions(), ...positions },
})

/** 读磁盘上的规则文件。 */
const readDisk = async () => JSON.parse(await readFile(CONFIG_FILE, 'utf8'))

/** 数一数归档文件。 */
const badFiles = async () =>
  (await readdir(join(home, 'dsh-prompt-inject'))).filter((name) => name.endsWith('.bad'))

check('配置文件落在 $DSH_HOME/dsh-prompt-inject/rules.json', CONFIG_FILE === join(home, 'dsh-prompt-inject', 'rules.json'), CONFIG_FILE)
check('v1 备份路径就是配置文件路径 + .v1.bak', LEGACY_BACKUP_FILE === `${CONFIG_FILE}.v1.bak`, LEGACY_BACKUP_FILE)

// 1. 文件不存在时给零组，revision 0。
const store = new ConfigStore()
const initial = await store.read()
check('首次读取：revision = 0', initial.revision === 0, String(initial.revision))
check('首次读取：groups 为空数组（新安装零组）', Array.isArray(initial.groups) && initial.groups.length === 0, JSON.stringify(initial.groups))
check('emptyGroups() 返回空数组', Array.isArray(emptyGroups()) && emptyGroups().length === 0)

// 2. 写一次：revision +1，文件真的落盘成 v2。
const written = await store.write(
  [group('g1', '组一', { 'user.prefix': { enabled: true, text: '总是用中文回答' } })],
  0,
)
check('写入后 revision = 1', written.revision === 1, String(written.revision))
const onDisk = await readDisk()
check('文件内容与写入一致', onDisk.revision === 1 && onDisk.groups[0].positions['user.prefix'].text === '总是用中文回答', JSON.stringify(onDisk))
check('文件带 version = 2', onDisk.version === 2, String(onDisk.version))
check('v2 文件里没有旧的 slots 键', onDisk.slots === undefined, JSON.stringify(Object.keys(onDisk)))

// 3. 空 groups 也是合法 v2：写进去、读出来都还是零组。
const emptied = await store.write(emptyGroups(), 1)
check('写入空 groups：revision = 2', emptied.revision === 2, String(emptied.revision))
check('写入空 groups：返回 groups = []', Array.isArray(emptied.groups) && emptied.groups.length === 0, JSON.stringify(emptied.groups))
const emptiedDisk = await readDisk()
check('空 groups 原样落盘', emptiedDisk.version === 2 && Array.isArray(emptiedDisk.groups) && emptiedDisk.groups.length === 0, JSON.stringify(emptiedDisk))

// 4. 乐观锁：用过期的 revision 写会被拒，并带上服务端最新值。
let mismatch
try {
  await store.write([group('g2', '组二')], 1)
} catch (error) {
  mismatch = error
}
check('过期 revision 写入被拒（code=revision-mismatch）', mismatch?.code === 'revision-mismatch', String(mismatch?.code))
check('被拒时返回服务端最新 revision 与 groups', mismatch?.revision === 2 && Array.isArray(mismatch?.groups) && mismatch.groups.length === 0, `${mismatch?.revision} / ${JSON.stringify(mismatch?.groups)}`)

// 5. 新实例（模拟重启）能读回同样的内容。
const reopened = new ConfigStore()
const reloaded = await reopened.read()
check('新实例读回 revision 2 与空 groups', reloaded.revision === 2 && reloaded.groups.length === 0, `${reloaded.revision} / ${reloaded.groups.length}`)

// 6. 外部手改文件（换 mtime/内容）能被发现，缺失位置自动补齐。
await writeFile(
  CONFIG_FILE,
  JSON.stringify(
    {
      version: 2,
      revision: 9,
      groups: [
        {
          id: 'gx',
          name: '外部手改',
          enabled: true,
          models: { all: true, list: [] },
          positions: { 'user.prefix': { enabled: true, text: '外部改的' } },
        },
      ],
    },
    null,
    2,
  ),
  'utf8',
)
const afterExternal = await reopened.read()
check('外部手改被发现并读回', afterExternal.revision === 9 && afterExternal.groups[0].positions['user.prefix'].text === '外部改的', `revision=${afterExternal.revision}`)
check('外部手改后缺失的位置被补齐成 8 个', Object.keys(afterExternal.groups[0].positions).length === 8, Object.keys(afterExternal.groups[0].positions).join(','))

// 7. 坏文件：改名归档 + 零组继续。
await writeFile(CONFIG_FILE, '{ this is not json', 'utf8')
const broken = new ConfigStore()
const recovered = await broken.read()
check('坏文件时给零组（revision 0）', recovered.revision === 0 && Array.isArray(recovered.groups) && recovered.groups.length === 0)
check('坏文件被改名成 .bad 保留现场', (await badFiles()).length >= 1, (await badFiles()).join(','))

// 8. 版本不认也走同一条路。
await writeFile(CONFIG_FILE, JSON.stringify({ version: 99, revision: 3, groups: [] }), 'utf8')
const wrongVersion = new ConfigStore()
const afterWrongVersion = await wrongVersion.read()
check('version 不认时给零组', afterWrongVersion.revision === 0 && afterWrongVersion.groups.length === 0)
check('version 不认的文件也被归档', (await badFiles()).length >= 2, (await badFiles()).join(','))

// 9. v1 文件迁移：合并文本、位置开关、revision 不变、备份、写回 v2。
const legacySlots = {
  'user.prefix': {
    rules: [
      { id: 'a', enabled: true, text: '规则 A', models: { all: true, list: [] } },
      { id: 'b', enabled: false, text: '规则 B', models: { all: true, list: [] } },
      { id: 'c', enabled: true, text: '规则 C', models: { all: false, list: ['p/m'] } },
    ],
  },
  'user.suffix': {
    rules: [{ id: 'd', enabled: false, text: '全关的后置', models: { all: true, list: [] } }],
  },
  'system.persona': {
    head: { rules: [{ id: 'h', enabled: true, text: '旧的头', models: { all: true, list: [] } }] },
    tail: { rules: [{ id: 't', enabled: true, text: '旧的尾', models: { all: true, list: [] } }] },
  },
  'system.beforeTools': { rules: [] },
}
await writeFile(CONFIG_FILE, JSON.stringify({ version: 1, revision: 5, slots: legacySlots }, null, 2), 'utf8')

const legacyStore = new ConfigStore()
const migrated = await legacyStore.read()
check('v1 迁移：revision 保持不变', migrated.revision === 5, String(migrated.revision))
check('v1 迁移：正好一个默认组', migrated.groups.length === 1 && migrated.groups[0].id === DEFAULT_GROUP_ID && migrated.groups[0].name === DEFAULT_GROUP_NAME, JSON.stringify(migrated.groups.map((item) => item.id)))
check('v1 迁移：默认组启用、对全部模型生效', migrated.groups[0].enabled === true && migrated.groups[0].models.all === true, JSON.stringify(migrated.groups[0].models))
check(
  'v1 迁移：同一位置的全部正文按顺序用空行合并（停用的也保留）',
  migrated.groups[0].positions['user.prefix'].text === '规则 A\n\n规则 B\n\n规则 C',
  migrated.groups[0].positions['user.prefix'].text,
)
check('v1 迁移：位置开关 = 原来至少有一条启用', migrated.groups[0].positions['user.prefix'].enabled === true && migrated.groups[0].positions['user.suffix'].enabled === false)
check('v1 迁移：旧 system.persona 拆到 persona 头 / 尾', migrated.groups[0].positions['system.personaHead'].text === '旧的头' && migrated.groups[0].positions['system.personaTail'].text === '旧的尾')
check('v1 迁移：缺失位置补成默认块', Object.keys(migrated.groups[0].positions).length === 8 && migrated.groups[0].positions['system.last'].text === '')

const backup = JSON.parse(await readFile(LEGACY_BACKUP_FILE, 'utf8'))
check('v1 迁移：备份文件 rules.json.v1.bak 保留原文件', backup.version === 1 && backup.revision === 5 && backup.slots['user.prefix'].rules[0].text === '规则 A')
check('v1 迁移：读完之后磁盘上仍是 v1（等用户下次保存）', (await readDisk()).version === 1, String((await readDisk()).version))

const migratedWritten = await legacyStore.write(migrated.groups, 5)
check('v1 迁移后写回：revision 5 → 6', migratedWritten.revision === 6, String(migratedWritten.revision))
const afterMigrationDisk = await readDisk()
check('v1 迁移后写回：磁盘变成 v2 且正文保留', afterMigrationDisk.version === 2 && afterMigrationDisk.groups[0].positions['user.prefix'].text === '规则 A\n\n规则 B\n\n规则 C', JSON.stringify(afterMigrationDisk))
check('v1 迁移后写回：备份文件还在', (await readdir(join(home, 'dsh-prompt-inject'))).includes('rules.json.v1.bak'))

// 9b. v1 文件即使 slots 全空也会生成一个默认组（只有「文件不存在」才是零组）。
await writeFile(CONFIG_FILE, JSON.stringify({ version: 1, revision: 7, slots: {} }, null, 2), 'utf8')
const emptyLegacy = await new ConfigStore().read()
check('v1 全空 slots 也迁出一个默认组（不是零组）', emptyLegacy.revision === 7 && emptyLegacy.groups.length === 1 && emptyLegacy.groups[0].id === DEFAULT_GROUP_ID && emptyLegacy.groups[0].positions['user.prefix'].enabled === false, JSON.stringify(emptyLegacy.groups))

// 10. 手写的 v2 空 groups 文件合法，不被归档。
await writeFile(CONFIG_FILE, JSON.stringify({ version: 2, revision: 3, groups: [] }, null, 2), 'utf8')
const emptyV2 = new ConfigStore()
const afterEmptyV2 = await emptyV2.read()
const badBeforeValidation = (await badFiles()).length
check('v2 空 groups 是合法文件：revision 3、零组、不归档', afterEmptyV2.revision === 3 && afterEmptyV2.groups.length === 0 && (await badFiles()).length === badBeforeValidation, `${afterEmptyV2.revision} / ${afterEmptyV2.groups.length}`)

// 11. 校验层与写入配合：合法组写进去，未知位置键被丢掉。
const accepted = validateGroups([
  group('v1', '通过校验', {
    'user.suffix': { enabled: true, text: '校验后' },
    'user.unknown': { enabled: true, text: '未知位置' },
  }),
])
check('合法 groups 通过校验', accepted.issues.length === 0 && accepted.groups !== null, JSON.stringify(accepted.issues))
check('未知位置键进 dropped、不进结果', accepted.dropped.length > 0 && accepted.groups[0].positions['user.unknown'] === undefined, JSON.stringify(accepted.dropped))
const validatedWrite = await emptyV2.write(accepted.groups, 3)
check('校验后的 groups 能写进去', validatedWrite.revision === 4 && validatedWrite.groups[0].positions['user.suffix'].text === '校验后', `${validatedWrite.revision}`)
check('写入后磁盘 v2 里没有未知位置键', (await readDisk()).groups[0].positions['user.unknown'] === undefined)

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
console.log(`（临时 DSH_HOME：${home}）`)
process.exit(failed.length === 0 ? 0 : 1)

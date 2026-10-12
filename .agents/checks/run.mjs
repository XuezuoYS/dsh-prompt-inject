/**
 * 验收脚本跑批。用法：`node .agents/checks/run.mjs [a|b|all]`（默认 `a`）。
 *
 * 为什么分两组：第二组的脚本要 import `@deepseek-ai/*`，那些包在发行包的 `app.asar` 里，
 * 磁盘上没有，得先按 `README.md` 第二节临时抽一份并挂上 `node_modules/@deepseek-ai` 的链接。
 * 第一组纯 node 就能跑，任何机器上 clone 下来都能验。
 *
 * 退出码：0 = 全通过；1 = 有脚本断言失败；2 = 第二组的环境没搭好（不是代码的问题）。
 *
 * 两个**手工探针**不在跑批里，因为它们不断言、只打印给人看：
 * `read-session.mjs`（解真机会话日志）和 `verify-timeline.mjs`（复刻多轮时间线肉眼核对）。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 仓库根（.agents/checks 往上两层）。子进程统一在这里跑，与手工执行的目录一致。 */
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

/** 第一组：不碰官方包。 */
const groupA = [
  'client-shape.mjs',
  'verify-template-fields.mjs',
  'verify-card-render.mjs',
  'verify-panel-toggle.mjs',
  'verify-model-route.mjs',
]

/** 第二组：要 `@deepseek-ai/*`（真 cordis / 真 SessionStore / 真原子写）。 */
const groupB = [
  'verify-logic.mjs',
  'verify-config-store.mjs',
  'verify-host-wiring.mjs',
  'verify-catalog-events.mjs',
  'verify-catalog-refresh.mjs',
  'verify-assemble-render.mjs',
  'verify-inject-flow.mjs',
  'verify-inject-persistence.mjs',
  'verify-derived-cache.mjs',
]

const groupNames = { a: '第一组（纯 node）', b: '第二组（要官方包）', all: '两组全部' }

/**
 * 官方包在不在？逐个脚本试 import 太慢，探一个代表就够了（cordis 是这批脚本的共同依赖）。
 * @returns {boolean} 能解析到 `@deepseek-ai/cordis` 时为 true。
 */
function hasOfficialPackages() {
  try {
    import.meta.resolve('@deepseek-ai/cordis')
    return true
  } catch {
    return false
  }
}

/**
 * 跑一个脚本，输出直连终端（各脚本自己打印 PASS / 计数）。
 * @param {string} file - `.agents/checks` 下的文件名。
 * @returns {Promise<number>} 退出码。
 */
function runOne(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`.agents/checks/${file}`], {
      cwd: repoRoot,
      stdio: 'inherit',
    })
    child.on('error', (error) => {
      console.error(`  ✗ ${file} 起不来：${String(error?.message ?? error)}`)
      resolve(1)
    })
    child.on('close', (code, signal) => resolve(signal === null ? (code ?? 1) : 1))
  })
}

/**
 * 跑一组并打印小结。
 * @param {string[]} files - 脚本文件名列表。
 * @param {string} title - 小结标题。
 * @returns {Promise<string[]>} 失败项的描述（空数组代表这组全绿）。
 */
async function runGroup(files, title) {
  console.log(`\n=== ${title} · ${files.length} 个脚本 ===`)
  const failures = []
  for (const file of files) {
    const code = await runOne(file)
    if (code !== 0) failures.push(`${file}（退出码 ${code}）`)
  }
  console.log(
    `--- ${title}：${files.length - failures.length}/${files.length} 通过` +
      (failures.length > 0 ? `，失败：${failures.join('、')}` : '') +
      ' ---',
  )
  return failures
}

const wanted = (process.argv[2] ?? 'a').toLowerCase()
if (!Object.hasOwn(groupNames, wanted)) {
  console.error(`用法：node .agents/checks/run.mjs [a|b|all]，收到 ${JSON.stringify(process.argv[2])}`)
  process.exit(1)
}

const failures = []

if (wanted === 'a' || wanted === 'all') {
  failures.push(...(await runGroup(groupA, groupNames.a)))
}

if (wanted === 'b' || wanted === 'all') {
  if (hasOfficialPackages()) {
    failures.push(...(await runGroup(groupB, groupNames.b)))
  } else {
    console.log(`\n=== ${groupNames.b}：跳过 ===`)
    console.log('没有 @deepseek-ai/* 可解析。这些包在发行包的 app.asar 里，要先临时抽一份：')
    console.log('  1) 看 .agents/checks/README.md 第二段的「要达到的形状」和那段 powershell')
    console.log('  2) 挂好 <仓库根>\\node_modules\\@deepseek-ai 的 junction 之后重跑 npm run test:host')
    console.log('  （只想验第一组的话：npm test 就够，它不需要任何官方包）')
    if (wanted === 'b') process.exit(2)
    failures.push('第二组没跑（环境未搭好）')
  }
}

if (failures.length > 0) {
  console.error(`\n合计失败 ${failures.length} 项：\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log(`\n全部通过（${wanted === 'all' ? groupA.length + groupB.length : (wanted === 'a' ? groupA.length : groupB.length)} 个脚本）`)

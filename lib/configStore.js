/**
 * 规则文件读写：`.dsh/dsh-prompt-inject/rules.json`。
 *
 * host 是唯一写者，写用「进程内排队 + 跨进程文件锁 + 原子替换」，
 * 每次成功写入 revision +1；文件坏掉或版本不认就改名成 `.bad` 再用空配置继续，不静默清空。
 *
 * @module dsh-prompt-inject/configStore
 */

import { mkdir, readFile, rename, stat } from 'node:fs/promises'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { CONFIG_VERSION, INJECT_POINTS } from './injectPoints.js'

/** 配置文件路径。 */
export const CONFIG_FILE = dshHomePath('dsh-prompt-inject', 'rules.json')

/** 规则文件的权限位（用户私有）。 */
const FILE_MODE = 0o600

/** 目录的权限位（用户私有）。 */
const DIR_MODE = 0o700

/** 等待跨进程写锁的最长时间。 */
const LOCK_WAIT_MS = 5000

/** 读文件失败时抛出的形态错误：交给调用方决定「当没配」还是「修文件」。 */
export class ConfigCorruptError extends Error {
  /**
   * @param {unknown} cause - 触发判断的原始错误。
   */
  constructor(cause) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'ConfigCorruptError'
  }
}

/**
 * 造一个空配置：所有注入点都在，规则列表全空。
 * @returns {Record<string, { rules: Array<object> }>} 空 slots。
 */
export function emptySlots() {
  const slots = {}
  for (const point of INJECT_POINTS) slots[point.key] = { rules: [] }
  return slots
}

/**
 * 判断一个值是不是「规则文件结构」（不校验每条规则的字段，那是校验层的事）。
 * @param {unknown} value - 待判断的值。
 * @returns {boolean} 结构可用时为真。
 */
function isConfigShape(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  if (value.version !== CONFIG_VERSION) return false
  if (value.slots === null || typeof value.slots !== 'object' || Array.isArray(value.slots)) return false
  const revision = value.revision
  return Number.isSafeInteger(revision) && revision >= 0
}

/**
 * 逐点规整配置：补齐缺失的注入点、丢掉结构不对的规则列表。
 * @param {object} config - 已通过结构校验的配置。
 * @returns {object} 规整后的配置。
 */
function normalize(config) {
  const slots = emptySlots()
  for (const point of INJECT_POINTS) {
    const rules = config.slots[point.key]?.rules
    slots[point.key] = { rules: Array.isArray(rules) ? rules : [] }
  }
  return { version: CONFIG_VERSION, revision: config.revision, slots }
}

/** 原子写规则文件的原始内容。 */
async function writeConfigFile(config) {
  const body = `${JSON.stringify(config, null, 2)}\n`
  await writeFileAtomic(CONFIG_FILE, body, { mode: FILE_MODE, dirMode: DIR_MODE })
}

/** 未持久化时的空配置（revision 从 0 算起）。 */
function emptyConfig() {
  return { version: CONFIG_VERSION, revision: 0, slots: emptySlots() }
}

/**
 * 规则配置的内存缓存 + 读写入口。
 *
 * 读路径不取锁：写入是原子替换，读者要么看到旧内容要么看到新内容；
 * 外部手改文件靠 mtime/size 变化被发现。
 */
export class ConfigStore {
  constructor() {
    /** 已解析的配置。 */
    this.config = emptyConfig()
    /** 是否已经尝试过一次加载。 */
    this.loaded = false
    /** 上次读到的文件标识（mtimeMs + size），用于发现外部改动。 */
    this.stamp = undefined
    /** 已知「文件不存在或坏掉」，下次读直接给内存里的状态。 */
    this.missing = true
    /** 已被改名归档的坏文件路径，避免同一进程里反复改名。 */
    this.quarantined = undefined
    /** 写操作排队，保证进程内不会交错。 */
    this.queue = Promise.resolve()
  }

  /**
   * 读当前配置（必要时重新读文件）。
   * @returns {Promise<{ revision: number, slots: object }>} 配置快照。
   */
  async read() {
    await this.ensureLoaded()
    return { revision: this.config.revision, slots: this.config.slots }
  }

  /**
   * 用新规则覆盖写，带 revision 乐观锁。
   * @param {object} slots - 新的 slots 对象（已通过校验层）。
   * @param {number} expectedRevision - 客户端手上的 revision。
   * @returns {Promise<{ revision: number, slots: object }>} 写入后的配置。
   * @throws {{ code: string, revision: number, slots: object }} 乐观锁失败时抛 code='revision-mismatch'。
   */
  async write(slots, expectedRevision) {
    const run = this.queue.then(() => this.writeLocked(slots, expectedRevision))
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * 真正干活的那一步：在文件锁里读最新状态、比对 revision、写回。
   * @param {object} slots - 新的 slots。
   * @param {number} expectedRevision - 客户端 revision。
   * @returns {Promise<{ revision: number, slots: object }>} 写入后的配置。
   */
  async writeLocked(slots, expectedRevision) {
    // 跨进程锁是同目录的 `<file>.lock`，父目录必须先存在。
    await ensureConfigDir()
    return withFileLock(CONFIG_FILE, async () => {
      const current = await this.readLocked()
      if (current.revision !== expectedRevision) {
        const mismatch = new Error(`rules.json revision mismatch: expected ${expectedRevision}, found ${current.revision}`)
        mismatch.code = 'revision-mismatch'
        mismatch.revision = current.revision
        mismatch.slots = current.slots
        throw mismatch
      }
      const next = { version: CONFIG_VERSION, revision: current.revision + 1, slots }
      await writeConfigFile(next)
      this.stamp = await this.stampOf()
      this.missing = false
      this.config = next
      return { revision: next.revision, slots: next.slots }
    }, { waitMs: LOCK_WAIT_MS })
  }

  /**
   * 确保内存里是最新的文件内容。
   * @returns {Promise<void>} 读完后返回。
   */
  async ensureLoaded() {
    if (this.missing && this.loaded) return
    if (!this.loaded) {
      this.loaded = true
      await this.reload()
      return
    }
    const current = await this.stampOf()
    if (current === undefined) {
      this.missing = true
      return
    }
    if (this.stamp !== undefined && current.mtimeMs === this.stamp.mtimeMs && current.size === this.stamp.size) return
    await this.reload()
  }

  /**
   * 强行从磁盘重读（允许坏文件改名归档）。
   * @returns {Promise<void>} 读完后返回。
   */
  async reload() {
    try {
      this.config = await this.readLocked()
      this.missing = false
    } catch (error) {
      if (error instanceof ConfigCorruptError) {
        await this.quarantine()
        this.config = emptyConfig()
        this.missing = true
        this.stamp = undefined
        return
      }
      throw error
    }
    this.stamp = await this.stampOf()
  }

  /**
   * 读一次文件；文件不存在给空配置，坏了往上抛 ConfigCorruptError。
   * @returns {Promise<object>} 解析好的配置。
   */
  async readLocked() {
    let raw
    try {
      raw = await readFile(CONFIG_FILE, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyConfig()
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new ConfigCorruptError(error)
    }
    if (!isConfigShape(parsed)) throw new ConfigCorruptError(new Error(`rules.json is not a version ${CONFIG_VERSION} config document`))
    return normalize(parsed)
  }

  /**
   * 把坏文件改名成 `rules.json.<时间戳>.bad`，保留现场。
   * @returns {Promise<void>} 改名完成后返回。
   */
  async quarantine() {
    const target = `${CONFIG_FILE}.${Date.now()}.bad`
    if (this.quarantined === target) return
    try {
      await rename(CONFIG_FILE, target)
      this.quarantined = target
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  /**
   * 取文件的 (mtimeMs, size) 标识，文件不存在给 undefined。
   * @returns {Promise<{mtimeMs: number, size: number} | undefined>} 文件标识。
   */
  async stampOf() {
    try {
      const info = await stat(CONFIG_FILE)
      return { mtimeMs: info.mtimeMs, size: info.size }
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }
}

/**
 * 确保配置目录存在（其它 API 想直接落盘时用）。
 * @returns {Promise<void>} 建完目录后返回。
 */
export async function ensureConfigDir() {
  await mkdir(dshHomePath('dsh-prompt-inject'), { recursive: true, mode: DIR_MODE })
}

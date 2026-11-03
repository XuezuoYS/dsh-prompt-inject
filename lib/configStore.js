/**
 * 配置文件读写：`.dsh/dsh-prompt-inject/rules.json`。
 *
 * host 是唯一写者，写用「进程内排队 + 跨进程文件锁 + 原子替换」，
 * 每次成功写入 revision +1；文件坏掉或版本不认就改名成带时间戳的 `.bad` 再用空配置继续，不静默清空。
 *
 * 结构版本：
 * - v1：`slots` → 每个注入点一串规则（老格式）；
 * - v2：`groups` → 一组「位置块」，groups 可以是空数组（零组状态）。
 *
 * v1 文件第一次被读到时，先在旁边留一份 `rules.json.v1.bak`，再在内存里迁移；
 * 用户下一次保存时才真正写成 v2。
 *
 * @module dsh-prompt-inject/configStore
 */

import { constants as fsConstants } from 'node:fs'
import { copyFile, mkdir, readFile, rename, stat } from 'node:fs/promises'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { CONFIG_VERSION } from './injectPoints.js'
import { emptyGroups, groupsFromLegacySlots, normalizeGroups } from './groupConfig.js'

export { emptyGroups }

/** 配置文件路径。 */
export const CONFIG_FILE = dshHomePath('dsh-prompt-inject', 'rules.json')

/** v1 文件迁移前的备份文件名。 */
export const LEGACY_BACKUP_FILE = `${CONFIG_FILE}.v1.bak`

/** 配置文件的权限位（用户私有）。 */
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
 * 判断一个值是不是「配置文件结构」（不校验组内字段，那是校验层的事）。
 * @param {unknown} value - 待判断的值。
 * @returns {boolean} 结构可用时为真。
 */
function isConfigShape(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const revision = value.revision
  if (!Number.isSafeInteger(revision) || revision < 0) return false
  if (value.version === 1) return value.slots !== null && typeof value.slots === 'object' && !Array.isArray(value.slots)
  if (value.version === CONFIG_VERSION) return Array.isArray(value.groups)
  return false
}

/**
 * 把磁盘上读到的配置规整成 v2 形状。
 * @param {object} config - 已通过结构校验的配置。
 * @returns {object} 规整后的 v2 配置。
 */
function normalize(config) {
  if (config.version === 1) {
    return { version: CONFIG_VERSION, revision: config.revision, groups: groupsFromLegacySlots(config.slots) }
  }
  return { version: CONFIG_VERSION, revision: config.revision, groups: normalizeGroups(config.groups) }
}

/** 原子写配置文件的原始内容。 */
async function writeConfigFile(config) {
  const body = `${JSON.stringify(config, null, 2)}\n`
  await writeFileAtomic(CONFIG_FILE, body, { mode: FILE_MODE, dirMode: DIR_MODE })
}

/** 未持久化时的空配置（revision 从 0 算起，零组）。 */
function emptyConfig() {
  return { version: CONFIG_VERSION, revision: 0, groups: emptyGroups() }
}

/**
 * 组配置的内存缓存 + 读写入口。
 *
 * 读路径不取锁：写入是原子替换，读者要么看到旧内容要么看到新内容；
 * 外部手改文件靠 mtime/size 变化被发现。
 */
export class ConfigStore {
  constructor() {
    /** 已解析的配置（始终是 v2 形状）。 */
    this.config = emptyConfig()
    /** 是否已经尝试过一次加载。 */
    this.loaded = false
    /** 上次读到的文件标识（mtimeMs + size），用于发现外部改动。 */
    this.stamp = undefined
    /** 已知「文件不存在或坏掉」，下次读直接给内存里的状态。 */
    this.missing = true
    /** 已被改名归档的坏文件路径，避免同一进程里反复改名。 */
    this.quarantined = undefined
    /** v1 备份是否已经尝试过（同一进程里只试一次）。 */
    this.legacyBackedUp = false
    /** 写操作排队，保证进程内不会交错。 */
    this.queue = Promise.resolve()
  }

  /**
   * 读当前配置（必要时重新读文件）。
   * @returns {Promise<{ revision: number, groups: Array<object> }>} 配置快照。
   */
  async read() {
    await this.ensureLoaded()
    return { revision: this.config.revision, groups: this.config.groups }
  }

  /**
   * 用新分组覆盖写，带 revision 乐观锁。
   * @param {Array<object>} groups - 新的 groups（已通过校验层）。
   * @param {number} expectedRevision - 客户端手上的 revision。
   * @returns {Promise<{ revision: number, groups: Array<object> }>} 写入后的配置。
   * @throws {{ code: string, revision: number, groups: Array<object> }} 乐观锁失败时抛 code='revision-mismatch'。
   */
  async write(groups, expectedRevision) {
    const run = this.queue.then(() => this.writeLocked(groups, expectedRevision))
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * 真正干活的那一步：在文件锁里读最新状态、比对 revision、写回。
   * @param {Array<object>} groups - 新的 groups。
   * @param {number} expectedRevision - 客户端 revision。
   * @returns {Promise<{ revision: number, groups: Array<object> }>} 写入后的配置。
   */
  async writeLocked(groups, expectedRevision) {
    // 跨进程锁是同目录的 `<file>.lock`，父目录必须先存在。
    await ensureConfigDir()
    return withFileLock(CONFIG_FILE, async () => {
      const current = await this.readLocked()
      if (current.revision !== expectedRevision) {
        const mismatch = new Error(`rules.json revision mismatch: expected ${expectedRevision}, found ${current.revision}`)
        mismatch.code = 'revision-mismatch'
        mismatch.revision = current.revision
        mismatch.groups = current.groups
        throw mismatch
      }
      const next = { version: CONFIG_VERSION, revision: current.revision + 1, groups }
      await writeConfigFile(next)
      this.stamp = await this.stampOf()
      this.missing = false
      this.config = next
      return { revision: next.revision, groups: next.groups }
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
   * @returns {Promise<object>} 解析好的 v2 配置。
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
    if (!isConfigShape(parsed)) {
      throw new ConfigCorruptError(new Error(`rules.json is not a supported config document (version 1 or ${CONFIG_VERSION})`))
    }
    if (parsed.version === 1) await this.backupLegacyOnce()
    return normalize(parsed)
  }

  /**
   * 给 v1 文件留一份 `rules.json.v1.bak`，同一进程只试一次。
   *
   * 备份失败不阻断迁移：文件里还有原文，最坏情况是这次没留下来；不能因为备份写不进去
   * 就让用户读不了配置。
   *
   * @returns {Promise<void>} 尝试完成后返回。
   */
  async backupLegacyOnce() {
    if (this.legacyBackedUp) return
    this.legacyBackedUp = true
    try {
      await copyFile(CONFIG_FILE, LEGACY_BACKUP_FILE, fsConstants.COPYFILE_EXCL)
    } catch {
      // 已经备份过（EEXIST）或没有权限：都不影响读取，静默继续。
    }
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

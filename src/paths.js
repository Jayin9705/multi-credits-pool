/**
 * 数据目录与 profile 定位。
 *
 * 与 DSH 的 profile 隔离策略一致：每个 profile 一份数据，互不串号。
 * 目录名用插件自己的前缀，不与已有插件（.workbuddy-auth.json 等）冲突。
 *
 * 宿主进程里拿不到 profile 名：桌面 App 不会把 `DSH_PROFILE` 放进环境变量，
 * 所以插件运行时靠扫描 `$DSH_HOME/profiles/*`、找出声明了本包的 profile 来定位。
 * CLI 里则按环境变量走。
 */
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_NAME = 'multi-credits-pool'
export const DATA_DIR_NAME = '.multi-credits-pool'

/** 显式指定数据目录，测试与特殊部署用。 */
const DATA_DIR_ENV = 'DSH_MULTI_CREDITS_POOL_DATA_DIR'

/** $DSH_HOME，默认 ~/.dsh。 */
export function homeDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 当前 profile 名（仅 CLI 场景可靠），默认 default。 */
export function profileName() {
  return process.env.DSH_PROFILE || 'default'
}

/** 本包的安装根目录：从本文件往上找到 name 匹配的 package.json。 */
export function packageRoot() {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth += 1) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).name === PACKAGE_NAME) return dir
      } catch {
        // 不是合法 JSON 就继续往上找
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function profileDeclaresPackage(profileDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    return (
      typeof manifest.dependencies?.[PACKAGE_NAME] === 'string' ||
      typeof manifest.devDependencies?.[PACKAGE_NAME] === 'string'
    )
  } catch {
    return false
  }
}

function profileLinksToPackage(profileDir) {
  const own = packageRoot()
  if (own === undefined) return false
  try {
    return realpathSync(join(profileDir, 'node_modules', PACKAGE_NAME)) === realpathSync(own)
  } catch {
    return false
  }
}

/**
 * 声明了本包的 profile 目录。
 *
 * 多个 profile 都声明时，用「node_modules 里的安装副本是否指向本包」判定，
 * 这样以目录联接方式安装的开发态也能落到正确的 profile。
 */
export function findProfileDir() {
  const profilesRoot = join(homeDir(), 'profiles')
  let entries
  try {
    entries = readdirSync(profilesRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dir = join(profilesRoot, entry.name)
    if (profileDeclaresPackage(dir)) candidates.push(dir)
  }
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]
  // 多个 profile 都声明时优先取安装副本指向本包的那个；都对不上就取第一个，
  // 保证结果稳定，不随目录枚举顺序变化。
  return candidates.find(candidate => profileLinksToPackage(candidate)) ?? candidates[0]
}

/** $DSH_HOME/profiles/$DSH_PROFILE（按环境变量推导的那一个）。 */
export function envProfileDir() {
  return join(homeDir(), 'profiles', profileName())
}

/** 改名前的数据目录名：装过老版本的机器上还留着账号与配置。 */
const LEGACY_DATA_DIR_NAMES = ['.dsh-workbuddy-multi']

/** 每个目标目录的迁移结果只算一次，避免反复试 rename。 */
const resolvedDataDirs = new Map()

/**
 * 把旧数据目录整体搬成新名字。
 *
 * 搬不动（被别的进程占用、权限不足）就继续用旧目录：账号在里面，不能因为
 * 一次迁移失败让它们凭空消失。返回值永远是「这一个进程该用的数据目录」。
 */
function resolveLegacyDataDir(target) {
  const cached = resolvedDataDirs.get(target)
  if (cached !== undefined) return cached
  let resolved = target
  for (const legacyName of LEGACY_DATA_DIR_NAMES) {
    const from = join(dirname(target), legacyName)
    if (from === target || !existsSync(from) || existsSync(target)) continue
    try {
      renameSync(from, target)
      console.warn(`[multi-credits-pool] 数据目录已迁移：${from} → ${target}`)
    } catch (error) {
      console.warn(
        `[multi-credits-pool] 数据目录迁移失败，继续用旧目录 ${from}：${error instanceof Error ? error.message : String(error)}`,
      )
      resolved = from
    }
    break
  }
  resolvedDataDirs.set(target, resolved)
  return resolved
}

/**
 * 当前 profile 目录。
 *
 * 优先级：声明的 profile > 环境变量推导。宿主里前者命中，CLI 里后者命中。
 */
export function profileDir() {
  return findProfileDir() ?? envProfileDir()
}

/** 插件数据目录；`DSH_MULTI_CREDITS_POOL_DATA_DIR` 可整体覆盖。 */
export function dataDir() {
  const override = process.env[DATA_DIR_ENV]
  if (override !== undefined && override.trim() !== '') return override
  return resolveLegacyDataDir(join(profileDir(), DATA_DIR_NAME))
}

export function accountsFile() {
  return join(dataDir(), 'accounts.json')
}

export function logFile() {
  return join(dataDir(), 'checkin-log.jsonl')
}

/** 使用流水：每次模型请求一行，供使用看板聚合。 */
export function usageFile() {
  return join(dataDir(), 'usage-log.jsonl')
}

/** 对话固定表：`{对话键: 账号 id}`，用户手动指定，重启后仍在。 */
export function pinsFile() {
  return join(dataDir(), 'pins.json')
}

/** 单账号签到锁目录：同一账号同一时刻只允许一个进程在签。 */
export function lockFile(accountId) {
  return join(dataDir(), `lock-${accountId}.lock`)
}

/**
 * 检查 npm 上有没有比本机更新的版本。
 *
 * 插件不能自己替换正在运行的代码：宿主进程已经把这些文件加载进内存，
 * 文件还被占用着。所以这里只负责「知道有没有新版」，真正的升级交给
 * `multi-credits-pool update` 那条命令，或者宿主的插件管理器重装一次。
 *
 * 注册表只在检查时问一次，结果缓存一段时间：打开看板会把状态文档拉一次，
 * 没有缓存就会每次刷新都打一遍 registry。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { packageRoot } from './paths.js'

export const REGISTRY_URL = 'https://registry.npmjs.org'
export const PACKAGE_NAME = 'multi-credits-pool'
export const DEFAULT_CHECK_TTL_MS = 10 * 60_000
export const DEFAULT_TIMEOUT_MS = 5000

/** 升级命令：面板与命令行提示同一句，用户不用自己想。 */
export function upgradeCommand(version) {
  return `multi-credits-pool update${typeof version === 'string' && version !== '' ? ` --to ${version}` : ''}`
}

/** 读本机安装的版本；读不到就当作未知（`undefined`），调用方据此放弃比较。 */
export function localVersion() {
  const root = packageRoot()
  if (root === undefined) return undefined
  try {
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
    return typeof version === 'string' && version !== '' ? version : undefined
  } catch {
    return undefined
  }
}

/**
 * 比较两个语义版本，只在「次版本之前」的位上比较。
 *
 * 返回 1 表示 `a` 比 `b` 新，-1 比它旧，0 相同。预发布后缀（`-rc.1`）按
 * 语义版本规则参与比较：没有后缀的正式版比带后缀的同号预发布版新。
 */
export function compareVersions(a, b) {
  const parse = text => {
    const [core, suffix] = String(text).split('-', 2)
    const nums = core.split('.').map(part => {
      const value = Number.parseInt(part, 10)
      return Number.isFinite(value) ? value : 0
    })
    return { nums, suffix }
  }
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < Math.max(left.nums.length, right.nums.length); index += 1) {
    const l = left.nums[index] ?? 0
    const r = right.nums[index] ?? 0
    if (l !== r) return l > r ? 1 : -1
  }
  if (left.suffix === right.suffix) return 0
  if (left.suffix === undefined) return 1
  if (right.suffix === undefined) return -1
  return left.suffix > right.suffix ? 1 : -1
}

/**
 * 问一次注册表。`fetch` 由调用方注入，测试里换成假的即可。
 *
 * 只读 `dist-tags.latest`：这是「别人 `npm i` 会装到的版本」，也是升级要跟的目标。
 * 网络不通、404、返回体不是对象都返回 `undefined`——检查更新失败不该让看板报错。
 */
export async function fetchLatestVersion(options = {}) {
  // 显式传 `fetch: undefined` 表示「这次不让联网」；不传才退回全局 fetch。
  const fetchImpl = 'fetch' in options ? options.fetch : globalThis.fetch
  if (typeof fetchImpl !== 'function') return undefined
  const base = (options.registryUrl ?? REGISTRY_URL).replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${base}/${options.packageName ?? PACKAGE_NAME}/latest`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    const body = await response.json()
    const version = body?.version
    return typeof version === 'string' && version !== '' ? version : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 检查更新，带缓存与并发合并：同一时刻只有一次网络请求。
 *
 * 返回 `{ current, latest, updateAvailable, command, checkedAt }`。
 * `latest` 取不到时 `updateAvailable` 为 `false`、`latest` 为 `undefined`，
 * 面板按「没查到」渲染，不能因此说「已是最新」。
 */
export function createUpdateChecker(options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_CHECK_TTL_MS
  const now = options.now ?? (() => Date.now())
  const readLocal = options.localVersion ?? localVersion
  let cached
  let pending

  return async function checkUpdate(force = false) {
    const current = readLocal()
    const at = now()
    if (!force && cached !== undefined && at - cached.checkedAt < ttlMs) {
      // 本机版本可能在两次检查之间变过（用户刚升级），缓存只缓存「远端有什么」。
      return { ...cached, current, updateAvailable: isNewer(cached.latest, current) }
    }
    if (pending === undefined) {
      pending = fetchLatestVersion(options).finally(() => {
        pending = undefined
      })
    }
    const latest = await pending
    cached = { latest, checkedAt: at }
    return {
      current,
      latest,
      updateAvailable: isNewer(latest, current),
      command: isNewer(latest, current) ? upgradeCommand(latest) : undefined,
      checkedAt: at,
    }
  }
}

function isNewer(latest, current) {
  if (typeof latest !== 'string' || typeof current !== 'string') return false
  return compareVersions(latest, current) > 0
}

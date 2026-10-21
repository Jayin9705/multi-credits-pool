/**
 * 使用流水：每次模型请求落一行，供使用看板按「账号 × 模型」聚合。
 *
 * 落盘格式是 JSONL，和签到流水一个套路——追加写、坏行跳过。之所以单独一个文件，
 * 是因为两者的读者和体量都不一样：签到一天几条，使用流水一天可能几百条。
 *
 * 这里刻意只记「请求级」事实（谁、哪个模型、什么时候、成没成、多少 token），
 * 不记积分扣减：上游 SSE 响应里没有逐次扣费读数，硬算只能靠猜。积分看板走余额，
 * 使用看板走请求量，两者各说各的，不互相编造。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dataDir, usageFile } from './paths.js'
import { utc8Date } from './protocol.js'

/** 流水文件超过这个行数就原地裁剪，只留最近的一半。 */
export const USAGE_COMPACT_LINES = 20_000

/** 看板展示的默认窗口：最近 7 天（含今天）。 */
export const USAGE_WINDOW_DAYS = 7

/** 看板最多展示多少个模型 / 账号分组。 */
export const USAGE_MAX_MODELS = 12
export const USAGE_MAX_ACCOUNTS = 12

function ensureDir() {
  const dir = dataDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 追加一条使用记录。
 *
 * 传进来的 `model` 缺省记成 `unknown`——上游偶尔不回模型名，缺字段不该让整条记录
 * 失效，否则看板会凭空少一截请求。
 */
export function appendUsage(entry) {
  if (entry === null || typeof entry !== 'object') return
  const row = {
    at: entry.at ?? new Date().toISOString(),
    accountId: String(entry.accountId ?? ''),
    model: String(entry.model ?? '') || 'unknown',
    ok: entry.ok === true,
  }
  if (typeof entry.conversationId === 'string' && entry.conversationId !== '') row.conversationId = entry.conversationId
  if (Number.isFinite(entry.promptTokens)) row.promptTokens = entry.promptTokens
  if (Number.isFinite(entry.completionTokens)) row.completionTokens = entry.completionTokens
  if (typeof entry.kind === 'string' && entry.kind !== '') row.kind = entry.kind
  try {
    ensureDir()
    appendFileSync(usageFile(), JSON.stringify(row) + '\n', 'utf8')
  } catch (error) {
    // 统计失败绝不能影响对话本身：请求已经成功了，日志写不进去就写不进去。
    console.warn(`[multi-credits-pool] 使用流水写入失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 读全部使用流水（容错：坏行跳过）。 */
export function readUsage() {
  const file = usageFile()
  if (!existsSync(file)) return []
  const rows = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      const row = JSON.parse(text)
      if (row !== null && typeof row === 'object') rows.push(row)
    } catch {
      // 坏行跳过。
    }
  }
  return rows
}

/** 流水太长时裁剪到最近一半，避免文件无限膨胀。返回是否真的裁剪过。 */
export function compactUsage(limit = USAGE_COMPACT_LINES) {
  const file = usageFile()
  if (!existsSync(file)) return false
  const lines = readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '')
  if (lines.length <= limit) return false
  const kept = lines.slice(-Math.floor(limit / 2))
  ensureDir()
  writeFileSync(file, kept.join('\n') + '\n', 'utf8')
  return true
}

/** `YYYY-MM-DD`（UTC+8）。 */
function dayOf(iso) {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? utc8Date(ms) : undefined
}

/**
 * 按「账号 × 模型」聚合。
 *
 * 返回结构直接对着界面：`totals` 给卡头，`accounts` 给行，每行里再嵌 `models`。
 * 排序按请求数从多到少，并列时按名字，保证同一份数据每次渲染顺序一致。
 */
export function aggregateUsage(rows, options = {}) {
  const nowMs = options.now ?? Date.now()
  const days = Math.max(1, Math.min(90, Math.floor(options.days ?? USAGE_WINDOW_DAYS)))
  const windowStart = nowMs - days * 24 * 60 * 60 * 1000

  const byAccount = new Map()
  let total = 0
  let failed = 0
  let promptTokens = 0
  let completionTokens = 0
  let earliest
  let latest

  for (const row of rows) {
    const atMs = Date.parse(row.at)
    if (!Number.isFinite(atMs) || atMs < windowStart) continue
    const accountId = typeof row.accountId === 'string' ? row.accountId : ''
    if (accountId === '') continue
    const model = typeof row.model === 'string' && row.model !== '' ? row.model : 'unknown'
    const ok = row.ok === true

    total += 1
    if (!ok) failed += 1
    if (Number.isFinite(row.promptTokens)) promptTokens += row.promptTokens
    if (Number.isFinite(row.completionTokens)) completionTokens += row.completionTokens
    if (earliest === undefined || atMs < earliest) earliest = atMs
    if (latest === undefined || atMs > latest) latest = atMs

    let bucket = byAccount.get(accountId)
    if (bucket === undefined) {
      bucket = { accountId, requests: 0, failed: 0, promptTokens: 0, completionTokens: 0, models: new Map(), lastAt: undefined }
      byAccount.set(accountId, bucket)
    }
    bucket.requests += 1
    if (!ok) bucket.failed += 1
    if (Number.isFinite(row.promptTokens)) bucket.promptTokens += row.promptTokens
    if (Number.isFinite(row.completionTokens)) bucket.completionTokens += row.completionTokens
    if (bucket.lastAt === undefined || atMs > bucket.lastAt) bucket.lastAt = atMs

    const modelBucket = bucket.models.get(model) ?? { model, requests: 0, failed: 0 }
    modelBucket.requests += 1
    if (!ok) modelBucket.failed += 1
    bucket.models.set(model, modelBucket)
  }

  const accounts = [...byAccount.values()]
    .sort((a, b) => (b.requests - a.requests) || String(a.accountId).localeCompare(String(b.accountId)))
    .slice(0, USAGE_MAX_ACCOUNTS)
    .map(bucket => ({
      accountId: bucket.accountId,
      requests: bucket.requests,
      failed: bucket.failed,
      promptTokens: bucket.promptTokens,
      completionTokens: bucket.completionTokens,
      lastAt: bucket.lastAt === undefined ? undefined : new Date(bucket.lastAt).toISOString(),
      models: [...bucket.models.values()]
        .sort((a, b) => (b.requests - a.requests) || a.model.localeCompare(b.model))
        .slice(0, USAGE_MAX_MODELS),
    }))

  const dayBuckets = new Map()
  for (const row of rows) {
    const atMs = Date.parse(row.at)
    if (!Number.isFinite(atMs) || atMs < windowStart) continue
    const day = dayOf(row.at)
    if (day === undefined) continue
    dayBuckets.set(day, (dayBuckets.get(day) ?? 0) + 1)
  }
  const daily = [...dayBuckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, requests]) => ({ day, requests }))

  return {
    days,
    total,
    failed,
    promptTokens,
    completionTokens,
    earliest: earliest === undefined ? undefined : new Date(earliest).toISOString(),
    latest: latest === undefined ? undefined : new Date(latest).toISOString(),
    accounts,
    daily,
  }
}

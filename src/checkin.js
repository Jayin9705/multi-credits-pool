/**
 * 每日签到。
 *
 * 判定顺序（与上游实测一致）：已签到 → 活动未开启 → 成功领到 → 其它失败。
 * 单账号加锁：宿主调度器和计划任务可能同时触发，同一账号同一时刻只允许一个在跑。
 */
import { existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { ensureFresh } from './auth.js'
import { lockFile } from './paths.js'
import {
  CHECKIN_URL,
  checkInHeaders,
  isObject,
  readEnvelope,
  utc8Date,
} from './protocol.js'
import { appendLog, patchAccount } from './store.js'

/** 锁超过这个时长视为上一个进程已死，可以抢。 */
const LOCK_STALE_MS = 10 * 60 * 1000

const DEFAULT_TIMEOUT_MS = 15_000

function acquireLock(accountId) {
  const file = lockFile(accountId)
  if (existsSync(file)) {
    try {
      if (Date.now() - statSync(file).mtimeMs < LOCK_STALE_MS) return false
    } catch {
      // 状态读不到就当陈旧锁处理。
    }
    try {
      unlinkSync(file)
    } catch {
      return false
    }
  }
  try {
    writeFileSync(file, String(process.pid), { flag: 'wx' })
    return true
  } catch {
    return false
  }
}

function releaseLock(accountId) {
  try {
    unlinkSync(lockFile(accountId))
  } catch {
    // 锁文件已经不在，忽略。
  }
}

function classify(response, payload, bodyText, nowMs) {
  const data = isObject(payload) ? payload : {}
  const code = typeof data.code === 'number' ? data.code : undefined
  const msg = typeof data.msg === 'string' ? data.msg : (typeof data.message === 'string' ? data.message : '')
  const inner = isObject(data.data) ? data.data : {}

  const already = code === 10001 || msg.includes('今天已签到') || msg.includes('已签到') || msg.toLowerCase().includes('already')
  if (already) return { status: 'already-claimed', message: msg || '今天已签到' }

  const noCampaign = inner.active === false || msg.includes('活动未开启') || msg.includes('已过期') || msg.toLowerCase().includes('not active')
  if (noCampaign) return { status: 'no-campaign', message: msg || '签到活动未开启' }

  const ok = response.ok && (code === 0 || code === 200 || code === undefined)
  if (ok) {
    const candidate = inner.credit ?? inner.amount ?? inner.points ?? data.credit ?? data.amount ?? data.points
    const amount = typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined
    return { status: 'claimed', amount, message: msg || (amount !== undefined ? `领取 ${amount} 积分` : '签到成功') }
  }

  return { status: 'error', message: msg || `HTTP ${response.status}: ${bodyText.slice(0, 120)}` }
}

/**
 * 给一个账号签到。
 *
 * @param {object} account 账号记录（含 id / region / accessToken / uid 等）
 * @param {{timeoutMs?: number}} options
 * @returns {Promise<{accountId: string, date: string, status: string, amount?: number, message: string}>}
 */
export async function checkInAccount(account, options = {}) {
  const nowMs = Date.now()
  const date = utc8Date(nowMs)
  const base = { accountId: account.id, date, status: 'error', message: '' }

  if (!account.accessToken) return { ...base, message: '没有访问令牌' }
  if (!acquireLock(account.id)) {
    return { ...base, message: '另一个签到进程正在处理这个账号，跳过' }
  }

  try {
    // 令牌过期就在这里刷掉，签到请求永远用新鲜的 access token。
    const fresh = await ensureFresh(account, patchAccount)
    const response = await fetch(CHECKIN_URL[fresh.region], {
      method: 'POST',
      headers: checkInHeaders(fresh),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    const bodyText = await response.text()
    let payload
    try {
      payload = JSON.parse(bodyText)
    } catch {
      payload = undefined
    }
    const verdict = classify(response, payload, bodyText, nowMs)
    const result = { accountId: account.id, date, ...verdict }

    // 流水是「今天签过没有」的唯一事实来源，成功与已签到都要落。
    appendLog({ kind: 'checkin', ...result })
    if (result.status === 'claimed' || result.status === 'already-claimed') {
      patchAccount(account.id, {
        lastCheckIn: { date, status: result.status, amount: result.amount, at: new Date().toISOString() },
      })
    }
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const result = { ...base, message }
    appendLog({ kind: 'checkin', ...result })
    return result
  } finally {
    releaseLock(account.id)
  }
}

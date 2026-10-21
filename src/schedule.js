/**
 * 签到调度：进程内定时（DSH 开着时）+ 单次扫（给 Windows 任务计划程序用）。
 *
 * 语义与参考实现一致：到点签；进程晚启动时只补当天、且只在已经过了签到时刻才
 * 补——活动没开门就跑，只会换来一条失败记录。
 */
import { checkInAccount } from './checkin.js'
import { isPastUtc8Time, msUntilNextUtc8, parseMinuteOfDay, utc8Date } from './protocol.js'
import { listAccounts } from './store.js'
import { pendingAccounts } from './summary.js'

/** 默认 10:00（UTC+8），上游活动通常在上午开放。 */
export const DEFAULT_CHECKIN_MINUTE = 600

/** 账号之间留出间隔：同一出口 IP 上的并发请求最容易被关联。 */
const GAP_MS = 1200

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 扫一遍。
 *
 * @param {{minuteOfDay?: number, force?: boolean, catchUp?: boolean, log?: (line: string) => void, quiet?: boolean}} options
 * @returns {Promise<{total: number, claimed: number, already: number, failed: number, skipped: number}>}
 */
export async function sweep(options = {}) {
  const log = options.log ?? (line => console.log(line))
  const quiet = options.quiet === true
  const minuteOfDay = options.minuteOfDay ?? DEFAULT_CHECKIN_MINUTE
  const all = listAccounts()
  if (all.length === 0) {
    log('账号库里没有账号，先运行 login 或 import。')
    return { total: 0, claimed: 0, already: 0, failed: 0, skipped: 0 }
  }

  const stats = { total: all.length, claimed: 0, already: 0, failed: 0, skipped: 0 }
  const today = utc8Date()

  if (options.catchUp && !isPastUtc8Time(minuteOfDay)) {
    if (!quiet) log(`今天还没到 ${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}（UTC+8），不补签。`)
    stats.skipped = all.length
    return stats
  }

  const targets = options.force ? all : pendingAccounts(all, Date.now())
  stats.skipped = all.length - targets.length
  if (targets.length === 0) {
    if (!quiet) log(`${today}：所有账号今天都签过了。`)
    return stats
  }

  for (const [index, account] of targets.entries()) {
    if (index > 0) await sleep(GAP_MS)
    const result = await checkInAccount(account)
    const name = `${result.accountId} ${account.label ?? ''}`.trim()
    switch (result.status) {
      case 'claimed':
        stats.claimed++
        log(`✔ ${name} 签到成功${result.amount !== undefined ? ` +${result.amount} 积分` : ''}`)
        break
      case 'already-claimed':
        stats.already++
        if (!quiet) log(`• ${name} 今天已经签过了`)
        break
      case 'no-campaign':
        stats.skipped++
        if (!quiet) log(`- ${name} 签到活动未开启`)
        break
      default:
        stats.failed++
        log(`✘ ${name} ${result.message ?? '签到失败'}`)
    }
  }
  return stats
}

/**
 * 常驻调度。启动时补当天，之后每天到点触发。
 *
 * @param {{at?: string, quiet?: boolean}} options
 */
export async function runDaemon(options = {}) {
  const minuteOfDay = parseMinuteOfDay(options.at) ?? DEFAULT_CHECKIN_MINUTE
  const label = `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`
  const log = line => console.log(`[${new Date().toISOString()}] ${line}`)
  log(`签到调度已启动，每天 ${label}（UTC+8）。Ctrl+C 退出；要免开 DSH，改用任务计划程序调 checkin。`)

  // 启动补签：只在今天已经过了签到时刻时才补。
  if (isPastUtc8Time(minuteOfDay)) {
    log('今天已过签到时刻，先补一次。')
    await sweep({ minuteOfDay, catchUp: true, log, quiet: options.quiet })
  }

  for (;;) {
    const wait = msUntilNextUtc8(minuteOfDay)
    log(`下一次签到在 ${Math.round(wait / 60_000)} 分钟后。`)
    await sleep(wait)
    await sweep({ minuteOfDay, log, quiet: options.quiet })
  }
}

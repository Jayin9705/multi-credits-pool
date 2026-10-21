/**
 * 汇总视图：把一个账号库聚成「今日签到 + 余额 + 月度累计」一张表。
 *
 * 余额读取对每个账号都是网络往返，失败只影响这一行（标出原因），不能拖垮整张
 * 表——这正是多账号场景下最常见的部分失败。
 */
import { ensureFresh } from './auth.js'
import { fetchCredits } from './balance.js'
import { patchAccount, readLog, checkedInToday } from './store.js'
import { utc8Date, utc8Month } from './protocol.js'

/** 今日某账号的签到结论（以流水为准）。 */
function todayVerdict(accountId, log, date) {
  const rows = log.filter(row => row.kind === 'checkin' && row.accountId === accountId && row.date === date)
  if (rows.length === 0) return { state: 'pending', amount: undefined }
  const claimed = rows.filter(row => row.status === 'claimed')
  if (claimed.length > 0) {
    const amount = claimed.reduce((sum, row) => sum + (typeof row.amount === 'number' ? row.amount : 0), 0)
    return { state: 'claimed', amount }
  }
  const last = rows[rows.length - 1]
  if (last.status === 'already-claimed') return { state: 'already', amount: undefined }
  return { state: last.status, amount: undefined, message: last.message }
}

/**
 * 还有余额的套餐里最早的到期时刻。
 *
 * 「优先过期」和界面上的倒计时都关心这个数，而用完的段不该参与：一段已经清零的
 * 积分哪怕明天到期，也不会让任何东西作废。
 */
export function earliestExpiryOf(packages) {
  if (!Array.isArray(packages)) return undefined
  let earliest
  for (const pkg of packages) {
    if (!(pkg.remain > 0) || pkg.unlimited === true) continue
    if (!Number.isFinite(pkg.endTimeMs)) continue
    if (earliest === undefined || pkg.endTimeMs < earliest) earliest = pkg.endTimeMs
  }
  return earliest
}

/**
 * 聚合一屏状态。
 *
 * @param {object[]} accounts
 * @param {{balance?: boolean}} options balance=false 时跳过余额请求（快照只看签到）
 */
export async function collectStatus(accounts, options = {}) {
  const nowMs = Date.now()
  const date = utc8Date(nowMs)
  const month = utc8Month(nowMs)
  const log = readLog()

  const rows = []
  for (const account of accounts) {
    const today = todayVerdict(account.id, log, date)
    const row = {
      id: account.id,
      label: account.label,
      region: account.region,
      uid: account.uid,
      nickname: account.nickname,
      enterprise: Boolean(account.enterpriseId),
      today,
      credits: undefined,
      totalSize: undefined,
      packages: [],
      groups: [],
      unlimited: false,
      creditsExpireAtMs: undefined,
      error: undefined,
      expiresAtMs: account.expiresAtMs,
      lastCheckIn: account.lastCheckIn,
    }
    if (options.balance !== false) {
      try {
        const fresh = await ensureFresh(account, patchAccount)
        const credits = await fetchCredits(fresh, fresh.accessToken)
        row.credits = credits.total
        row.totalSize = credits.totalSize
        row.packages = credits.packages
        row.groups = credits.groups
        row.unlimited = credits.unlimited === true
        row.kind = credits.kind
        // 账号级到期：取「还有余额且最早到期」的那一段，用完了的段不该决定这条线索。
        row.creditsExpireAtMs = earliestExpiryOf(credits.packages)
      } catch (error) {
        row.error = error instanceof Error ? error.message : String(error)
      }
    }
    rows.push(row)
  }

  const monthEntries = log.filter(row => row.kind === 'checkin' && row.date.startsWith(month) && row.status === 'claimed')
  const todayEntries = log.filter(row => row.kind === 'checkin' && row.date === date && row.status === 'claimed')

  return {
    date,
    month,
    rows,
    totals: {
      claimedToday: todayEntries.reduce((sum, row) => sum + (typeof row.amount === 'number' ? row.amount : 0), 0),
      claimedTodayCount: todayEntries.length,
      claimedMonth: monthEntries.reduce((sum, row) => sum + (typeof row.amount === 'number' ? row.amount : 0), 0),
      claimedMonthCount: monthEntries.length,
      creditsRemaining: rows.reduce((sum, row) => sum + (typeof row.credits === 'number' ? row.credits : 0), 0),
      creditsTotal: rows.reduce((sum, row) => sum + (typeof row.totalSize === 'number' ? row.totalSize : 0), 0),
      accounts: rows.length,
      checkedIn: rows.filter(row => row.today.state === 'claimed' || row.today.state === 'already').length,
      failed: rows.filter(row => row.today.state === 'error').length,
      balanceErrors: rows.filter(row => row.error !== undefined).length,
    },
  }
}

/**
 * 把任意文本压成单行短文本。
 *
 * 上游错误常常带换行甚至整段 HTML（401 页面），直接塞进表格会把 Markdown 表格
 * 撑破，终端里也会刷屏。展示层统一收口到这里。
 */
export function oneLine(text, limit = 160) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/** 中日韩字符占两列，表格对齐必须按显示宽度算。 */
export function displayWidth(text) {  let width = 0
  for (const char of String(text)) {
    const code = char.codePointAt(0) ?? 0
    width += (code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6))) ? 2 : 1
  }
  return width
}

function pad(text, width) {
  const value = String(text ?? '')
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)))
}

function todayText(today) {
  switch (today.state) {
    case 'claimed': return today.amount !== undefined ? `已签 +${today.amount}` : '已签'
    case 'already': return '今日已签'
    case 'pending': return '未签'
    case 'no-campaign': return '无活动'
    case 'error': return '失败'
    default: return String(today.state)
  }
}

function expiryText(expiresAtMs) {
  if (!expiresAtMs) return '(导入)'
  const days = Math.ceil((expiresAtMs - Date.now()) / 86_400_000)
  if (days <= 0) return '已过期'
  return `${days} 天`
}

/** 终端表格。每行一个账号，最后一行合计。 */
export function renderTable(status) {
  const headers = ['ID', '账号', '区域', '今日', '剩余积分', '套餐', '令牌']
  const body = status.rows.map(row => [
    row.id,
    oneLine(row.label || row.nickname || '(未命名)', 24),
    row.region === 'global' ? '国际' : '国内',
    todayText(row.today),
    row.error !== undefined ? '读取失败' : (typeof row.credits === 'number' ? String(row.credits) : '-'),
    row.error !== undefined ? '-' : String(row.packages.length || '-'),
    expiryText(row.expiresAtMs),
  ])
  const totals = [
    '',
    `合计 ${status.totals.accounts} 个账号`,
    '',
    `${status.totals.checkedIn}/${status.totals.accounts}`,
    String(status.totals.creditsRemaining),
    '',
    '',
  ]
  const widths = headers.map((header, index) => Math.max(
    displayWidth(header),
    ...body.map(row => displayWidth(row[index])),
    displayWidth(totals[index]),
  ))
  const line = cells => cells.map((cell, index) => pad(cell, widths[index])).join('  ').trimEnd()
  const rule = widths.map(width => '─'.repeat(width)).join('  ')

  const lines = [line(headers), rule, ...body.map(line), rule, line(totals)]
  const errors = status.rows.filter(row => row.error !== undefined)
  if (errors.length > 0) {
    lines.push('', '余额读取失败的账号：')
    for (const row of errors) lines.push(`  ${row.id} ${oneLine(row.label, 24)}：${oneLine(row.error)}`)
  }
  const failed = status.rows.filter(row => row.today.state === 'error')
  if (failed.length > 0) {
    lines.push('', '今日签到失败的账号：')
    for (const row of failed) lines.push(`  ${row.id} ${oneLine(row.label, 24)}：${oneLine(row.today.message ?? '未知原因')}`)
  }
  return lines.join('\n')
}

/** Markdown 表格单元格：压成单行并转义竖线，否则一行脏文本能把整张表撑破。 */
function markdownCell(text, limit = 120) {
  return oneLine(text, limit).replace(/\|/g, '\\|')
}

/** Markdown 版本，供 report 落盘。 */
export function renderMarkdown(status) {
  const lines = []
  lines.push(`# multi-credits-pool签到与积分汇总（${status.date}）`, '')
  lines.push('## 今日')
  lines.push('')
  lines.push(`- 账号数：${status.totals.accounts}`)
  lines.push(`- 今日已签：${status.totals.checkedIn}/${status.totals.accounts}，今日领取 ${status.totals.claimedToday} 积分`)
  lines.push(`- 失败：${status.totals.failed}`)
  lines.push(`- 剩余积分合计：${status.totals.creditsRemaining}${status.totals.creditsTotal ? ` / ${status.totals.creditsTotal}` : ''}`)
  lines.push('')
  lines.push('## 账号明细')
  lines.push('')
  lines.push('| ID | 账号 | 区域 | 类型 | 今日 | 剩余积分 | 总量 | 令牌有效期 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const row of status.rows) {
    lines.push([
      `\`${row.id}\``,
      markdownCell(row.label || row.nickname || '(未命名)'),
      row.region === 'global' ? '国际' : '国内',
      row.kind === 'enterprise' ? '企业' : '个人',
      todayText(row.today),
      row.error !== undefined ? markdownCell(`读取失败（${row.error}）`) : String(row.credits ?? '-'),
      row.error !== undefined ? '-' : String(row.totalSize ?? '-'),
      expiryText(row.expiresAtMs),
    ].join(' | ').replace(/^/, '| ').concat(' |'))
  }
  lines.push('')
  lines.push('## 套餐明细')
  lines.push('')
  for (const row of status.rows) {
    if (row.error !== undefined) {
      lines.push(`### ${row.label}（${row.id}）`, '')
      lines.push(`余额读取失败：${markdownCell(row.error)}`, '')
      continue
    }
    if (row.packages.length === 0) continue
    lines.push(`### ${row.label}（${row.id}）`, '')
    lines.push(`合计剩余 ${row.credits}${row.totalSize === undefined ? '' : ` / ${row.totalSize}`}，共 ${row.packages.length} 段`, '')
    lines.push('| 套餐 | 剩余 | 总量 | 周期开始 | 到期 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const pkg of row.packages) {
      lines.push(`| ${markdownCell(pkg.packageName)} | ${pkg.remain} | ${pkg.size} | ${pkg.startTime ?? '-'} | ${pkg.endTime ?? '-'} |`)
    }
    lines.push('')
  }
  lines.push('## 月度累计', '')
  lines.push(`- ${status.month}：已签 ${status.totals.claimedMonthCount} 次，累计 ${status.totals.claimedMonth} 积分`)
  return lines.join('\n') + '\n'
}

/** 供调度器使用的「今天还没签」判定。 */
export function pendingAccounts(accounts, nowMs = Date.now()) {
  return accounts.filter(account => !checkedInToday(account.id, nowMs))
}

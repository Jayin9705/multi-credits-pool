/**
 * WorkBuddy 上游协议常量与请求头。
 *
 * 全部取自参考实现（dsh-workbuddy-connect）的实测结果，不做猜测：
 * - 登录：POST {loginBase}/v2/plugin/auth/state?platform=CLI，轮询
 *   GET {loginBase}/v2/plugin/auth/token?state=…
 * - 刷新：POST {chatBase}/v2/plugin/auth/token/refresh，刷新令牌只放在
 *   X-Refresh-Token 头里，且只在这一个请求上出现。
 * - 签到：POST {cn|global}/v2/billing/meter/daily-checkin，body 为 {}。
 * - 余额：POST {billingBase}/v2/billing/meter/get-user-resource（国际版先试无 /v2 前缀）。
 */
import { createHash } from 'node:crypto'

/** 两个区域。cn = www.workbuddy.cn / codebuddy.cn，global = www.workbuddy.ai。 */
export const REGIONS = ['cn', 'global']

export const CHAT_BASE = {
  cn: 'https://copilot.tencent.com',
  global: 'https://www.workbuddy.ai',
}

export const BILLING_BASE = {
  cn: 'https://www.codebuddy.cn',
  global: 'https://www.workbuddy.ai',
}

export const LOGIN_BASE = {
  cn: 'https://www.codebuddy.cn',
  global: 'https://www.workbuddy.ai',
}

/** 登录请求的 Origin 与聊天/计费不同：CN 走 copilot.tencent.com。 */
export const LOGIN_ORIGIN = {
  cn: 'https://copilot.tencent.com',
  global: 'https://www.workbuddy.ai',
}

export const CHECKIN_URL = {
  cn: 'https://www.workbuddy.cn/v2/billing/meter/daily-checkin',
  global: 'https://www.workbuddy.ai/v2/billing/meter/daily-checkin',
}

/** 签到与余额共用的站点 Origin（Referer 也用它）。 */
export const SITE_ORIGIN = {
  cn: 'https://www.workbuddy.cn',
  global: 'https://www.workbuddy.ai',
}

/** 官方 CLI 身份；上游按它分流。 */
export const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
export const LOGIN_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

/** IDE 身份：聊天请求用它做归属统计，与 User-Agent 里的版本号一致。 */
export const WORKBUDDY_CLIENT_NAME = 'CodeBuddy'
export const CLIENT_VERSION = '2.63.2'

export const GLOBAL_DOMAIN = 'www.workbuddy.ai'

/** 登录轮询里表示「浏览器那半还没完成」的业务码。 */
export const LOGIN_PENDING_CODE = 11217

const DEFAULT_TIMEOUT_MS = 15_000
const LOGIN_TIMEOUT_MS = 30_000
export const JSON_TIMEOUT_MS = 20_000

export function timeoutSignal(ms = DEFAULT_TIMEOUT_MS) {
  return AbortSignal.timeout(ms)
}

export function loginTimeoutSignal() {
  return AbortSignal.timeout(LOGIN_TIMEOUT_MS)
}

/** 一个账号一个稳定 36 位 id（sha256 截断），用于设备指纹。 */
export function deriveStableId(uid, purpose) {
  return createHash('sha256').update(`wb2a:${purpose}:${uid}`).digest('hex').slice(0, 36)
}

/** 上游把缺失或飘忽的指纹当成「同一个客户端」，所以必须按 uid 派生。 */
export function deviceHeaders(uid) {
  if (!uid || uid.trim() === '') return {}
  return {
    'X-Machine-ID': deriveStableId(uid, 'machine'),
    'X-Session-ID': deriveStableId(uid, 'session'),
  }
}

/** 账号短 id：同一 uid 在同一区域永远映射到同一个 id。 */
export function accountIdOf(account) {
  const seed = `${account.region}:${account.uid || account.accessToken.slice(0, 16)}`
  return createHash('sha256').update(seed).digest('hex').slice(0, 8)
}

export function acceptLanguageFor(region) {
  return region === 'global' ? 'en-US' : 'zh-CN'
}

/** 通用头：所有上游请求共享的这一份。 */
export function commonHeaders(account) {
  const region = account.region
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: SITE_ORIGIN[region],
    Referer: `${SITE_ORIGIN[region]}/`,
    'User-Agent': CLIENT_UA,
    'X-CodeBuddy-Request': '1',
    'Accept-Language': acceptLanguageFor(region),
    ...deviceHeaders(account.uid),
  }
}

/** 签到头：与余额头不同，Referer 指向成长中心。 */
export function checkInHeaders(account) {
  const region = account.region
  const headers = {
    Authorization: `Bearer ${account.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    Origin: SITE_ORIGIN[region],
    Referer: `${SITE_ORIGIN[region]}/profile/growth-center`,
    'User-Agent': CLIENT_UA,
    'X-CodeBuddy-Request': '1',
    'Accept-Language': acceptLanguageFor(region),
    ...deviceHeaders(account.uid),
  }
  if (account.uid) headers['X-User-Id'] = account.uid
  if (region === 'global') {
    headers['X-Domain'] = GLOBAL_DOMAIN
    headers['X-No-Enterprise-Id'] = '1'
  } else {
    if (account.enterpriseId) {
      headers['X-Enterprise-Id'] = account.enterpriseId
      headers['X-Tenant-Id'] = account.enterpriseId
    } else {
      headers['X-No-Enterprise-Id'] = '1'
    }
    if (account.domain) headers['X-Domain'] = account.domain
  }
  return headers
}

/** 计费头：官方客户端在这里同样带门禁头和设备指纹。 */
export function billingHeaders(account) {
  const headers = {
    Authorization: `Bearer ${account.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-CodeBuddy-Request': '1',
    'Accept-Language': acceptLanguageFor(account.region),
    'User-Agent': CLIENT_UA,
    ...deviceHeaders(account.uid),
  }
  if (account.uid) headers['X-User-Id'] = account.uid
  if (account.enterpriseId) {
    headers['X-Enterprise-Id'] = account.enterpriseId
    headers['X-Tenant-Id'] = account.enterpriseId
  }
  if (account.domain) headers['X-Domain'] = account.domain
  return headers
}

/**
 * 聊天请求头。
 *
 * 与签到/计费的差别：接受事件流、必须声明 IDE 身份与用途（上游按它做归属统计），
 * 且国际站无条件声明「个人国际客户端」——带 enterpriseId 或登录域名会被拒绝。
 */
export function chatHeaders(account) {
  const region = account.region
  const headers = {
    ...commonHeaders(account),
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${account.accessToken}`,
    'X-User-Id': account.uid || '1',
  }
  if (region === 'global') {
    headers['X-Domain'] = GLOBAL_DOMAIN
    headers['X-No-Enterprise-Id'] = '1'
  } else if (account.enterpriseId) {
    headers['X-Enterprise-Id'] = account.enterpriseId
  } else {
    headers['X-No-Enterprise-Id'] = '1'
  }
  Object.assign(headers, {
    'X-Agent-Purpose': 'conversation',
    'X-IDE-Name': WORKBUDDY_CLIENT_NAME,
    'X-IDE-Type': WORKBUDDY_CLIENT_NAME,
    'X-IDE-Version': CLIENT_VERSION,
    'X-Product': WORKBUDDY_CLIENT_NAME,
  })
  return headers
}

/** 聊天基址。 */
export function chatBaseOf(region) {
  return CHAT_BASE[region]
}

/** 聊天路径：国际站先走 console 路径，CN 只有共享路径。 */
export function chatPaths(region) {
  return region === 'global'
    ? ['/console/chat/completions', '/v2/chat/completions']
    : ['/v2/chat/completions']
}

/** 刷新头：X-Refresh-Token 与 X-Auth-Refresh-Source 只出现在这里。 */
export function refreshHeaders(account) {  const headers = {
    ...commonHeaders(account),
    'X-Refresh-Token': account.refreshToken,
    'X-Auth-Refresh-Source': 'plugin',
  }
  if (account.enterpriseId) headers['X-Enterprise-Id'] = account.enterpriseId
  return headers
}

/** 登录请求头。Cookie 由调用方按尝试携带。 */
export function loginHeaders(region, cookie) {
  const origin = LOGIN_ORIGIN[region]
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': LOGIN_UA,
    ...(cookie ? { Cookie: cookie } : {}),
  }
}

/** 余额路径：国际版先试无 /v2 的那个，CN 只有带 /v2 的那个。 */
export function billingMeterPaths(region) {
  const withVersion = '/v2/billing/meter/get-user-resource'
  const withoutVersion = '/billing/meter/get-user-resource'
  return region === 'global' ? [withoutVersion, withVersion] : [withVersion]
}

/** 路由落空才允许换路径重试；业务错误必须原样报出。 */
export function isPathMiss(status) {
  return status === 404 || status === 405
}

/**
 * UTC+8 的日期与时刻。
 *
 * 上游的活动按北京时间换日，所以不能依赖宿主机时区：一律用 UTC+8 换算后再取
 * UTC 字段。
 */
const UTC8_OFFSET_MS = 8 * 3600 * 1000

function utc8Parts(nowMs = Date.now()) {
  const shifted = new Date(nowMs + UTC8_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay(),
  }
}

const pad = n => String(n).padStart(2, '0')

/** YYYY-MM-DD（UTC+8）。 */
export function utc8Date(nowMs = Date.now()) {
  const p = utc8Parts(nowMs)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/** YYYY-MM（UTC+8），用于月度累计。 */
export function utc8Month(nowMs = Date.now()) {
  const p = utc8Parts(nowMs)
  return `${p.year}-${pad(p.month)}`
}

/** YYYY-MM-DD HH:mm:ss（UTC+8），计费查询的时间窗口参数。 */
export function utc8DateTime(nowMs = Date.now()) {
  const p = utc8Parts(nowMs)
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
}

/** 距离下一个 UTC+8 的 HH:MM 还有多少毫秒；已过则指向明天。 */
export function msUntilNextUtc8(minuteOfDay, nowMs = Date.now()) {
  const p = utc8Parts(nowMs)
  const minutesNow = p.hour * 60 + p.minute
  let delta = minuteOfDay - minutesNow
  if (delta <= 0) delta += 24 * 60
  const secondsNow = p.second + (nowMs % 1000) / 1000
  return delta * 60_000 - secondsNow * 1000
}

/** 今天是否已过 UTC+8 的 HH:MM。 */
export function isPastUtc8Time(minuteOfDay, nowMs = Date.now()) {
  const p = utc8Parts(nowMs)
  return p.hour * 60 + p.minute >= minuteOfDay
}

/** 'HH:MM' → 当日分钟数。 */
export function parseMinuteOfDay(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (!match) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return undefined
  return hour * 60 + minute
}

/** 读一个上游 {code,msg,data} 信封；非 JSON 或结构不对都当成上游异常。 */
export async function readEnvelope(response) {
  const text = stripBom(await response.text())
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`上游返回非 JSON（http ${response.status}）：${text.slice(0, 160)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`上游返回了意外的文档（http ${response.status}）`)
  }
  return {
    code: typeof parsed.code === 'number' ? parsed.code : 0,
    msg: typeof parsed.msg === 'string' ? parsed.msg : (typeof parsed.message === 'string' ? parsed.message : ''),
    data: parsed.data,
    document: parsed,
  }
}

export function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function optionalString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 去掉 UTF-8 BOM。
 *
 * Windows 上的文本工具（PowerShell 的 Set-Content、记事本、部分导出器）写 JSON 时
 * 会带 BOM，JSON.parse 遇到它直接抛错。凭据文件常常是手工导出或从别处拷来的，
 * 所以读文件与解析响应都要先剥掉。
 */
export function stripBom(text) {
  const value = String(text ?? '')
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
}

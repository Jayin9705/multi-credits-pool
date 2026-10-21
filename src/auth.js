/**
 * 账号凭据：浏览器设备授权登录、令牌刷新、外部凭据导入。
 *
 * 登录是「设备授权」形状：先申请 state 与授权 URL，人在浏览器里完成，再轮询换
 * 令牌。CN 网关在申请 state 时下发 Cookie，之后的轮询必须原样带上，否则永远
 * 停在 pending。
 */
import { spawn } from 'node:child_process'
import {
  CHAT_BASE,
  JSON_TIMEOUT_MS,
  LOGIN_BASE,
  LOGIN_PENDING_CODE,
  isObject,
  loginHeaders,
  loginTimeoutSignal,
  optionalString,
  readEnvelope,
  refreshHeaders,
} from './protocol.js'

/** 每次登录尝试各自一份 Cookie，按 state 索引。CLI 单进程、串行登录即可。 */
const jars = new Map()

function absorbCookies(state, response) {
  const jar = jars.get(state) ?? new Map()
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(';', 1)[0] ?? ''
    const at = pair.indexOf('=')
    if (at <= 0) continue
    jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
  }
  jars.set(state, jar)
}

function cookieHeader(state) {
  const jar = jars.get(state)
  if (!jar || jar.size === 0) return undefined
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
}

/** 'cn' / 'global' 归一化：认不出来的都当 cn，与上游默认部署一致。 */
export function normalizeRegion(value) {
  return String(value ?? '').trim().toLowerCase() === 'global' ? 'global' : 'cn'
}

/** 域名 → 区域。空域名归 CN。 */
export function regionOfDomain(domain) {
  return String(domain ?? '').toLowerCase().includes('workbuddy.ai') ? 'global' : 'cn'
}

/** 授权 URL 的落地区域以返回的 domain 为准，除非 domain 为空。 */
export function resolveRegion(startedRegion, domain) {
  return String(domain ?? '').trim() === '' ? startedRegion : regionOfDomain(domain)
}

/**
 * 发起一次登录尝试。
 * @returns {Promise<{state: string, authUrl: string, region: string}>}
 */
export async function beginLogin(region) {
  const zone = normalizeRegion(region)
  const response = await fetch(`${LOGIN_BASE[zone]}/v2/plugin/auth/state?platform=CLI`, {
    method: 'POST',
    headers: loginHeaders(zone, undefined),
    body: '{}',
    signal: loginTimeoutSignal(),
  })
  const envelope = await readEnvelope(response)
  // Cookie 必须在读 body 之后收，getSetCookie 不依赖 body，但顺序上放在这里更清楚。
  const data = isObject(envelope.data) ? envelope.data : {}
  const state = optionalString(data.state)
  const authUrl = optionalString(data.authUrl)
  if (!response.ok || envelope.code !== 0) {
    throw new Error(`申请登录 state 失败（http ${response.status}, code ${envelope.code}）：${envelope.msg.slice(0, 160)}`)
  }
  if (state === undefined || authUrl === undefined) {
    throw new Error('登录 state 响应里没有 state 或 authUrl')
  }
  jars.set(state, jars.get(state) ?? new Map())
  absorbCookies(state, response)
  return { state, authUrl, region: zone }
}

/**
 * 轮询一次。
 *
 * pending 覆盖两种情况：人还没在浏览器里完成（业务码 11217），以及网关暂时拒绝
 * 这次轮询（4xx）。5xx 与网络错误必须抛出去，否则真实的故障会被伪装成「还在
 * 等待」。
 */
export async function pollLogin(attempt) {
  const cookie = cookieHeader(attempt.state)
  const response = await fetch(
    `${LOGIN_BASE[attempt.region]}/v2/plugin/auth/token?state=${encodeURIComponent(attempt.state)}`,
    { method: 'GET', headers: loginHeaders(attempt.region, cookie), signal: loginTimeoutSignal() },
  )
  absorbCookies(attempt.state, response)
  if (response.status >= 500) throw new Error(`换取令牌失败（http ${response.status}）`)
  if (response.status >= 400) return { status: 'pending' }
  const envelope = await readEnvelope(response)
  if (envelope.code === LOGIN_PENDING_CODE || envelope.code !== 0) return { status: 'pending' }
  const data = isObject(envelope.data) ? envelope.data : {}
  const accessToken = optionalString(data.accessToken)
  if (accessToken === undefined) return { status: 'pending' }
  const tokens = {
    accessToken,
    refreshToken: optionalString(data.refreshToken) ?? '',
    expiresInSec: typeof data.expiresIn === 'number' && data.expiresIn > 0 ? data.expiresIn : 0,
    domain: optionalString(data.domain) ?? '',
  }
  const account = await fetchAccount(attempt, tokens.accessToken, cookie)
  return { status: 'complete', tokens, account }
}

/** 读账号身份。尽力而为：身份只影响显示名和 X-User-Id，失败不能丢凭据。 */
async function fetchAccount(attempt, accessToken, cookie) {
  try {
    const response = await fetch(
      `${LOGIN_BASE[attempt.region]}/v2/plugin/login/account?state=${encodeURIComponent(attempt.state)}`,
      {
        method: 'GET',
        headers: { ...loginHeaders(attempt.region, cookie), Authorization: `Bearer ${accessToken}` },
        signal: loginTimeoutSignal(),
      },
    )
    absorbCookies(attempt.state, response)
    if (!response.ok) return { uid: '' }
    const envelope = await readEnvelope(response)
    const data = isObject(envelope.data) ? envelope.data : {}
    return {
      uid: optionalString(data.uid) ?? '',
      nickname: optionalString(data.nickname),
      enterpriseId: optionalString(data.enterpriseId),
    }
  } catch {
    return { uid: '' }
  }
}

export function forgetLogin(state) {
  jars.delete(state)
}

/** 把一次完成的登录转成账号记录（还未落盘）。 */
export function accountFromLogin({ region, tokens, account, label }) {
  const now = Date.now()
  return {
    region: resolveRegion(normalizeRegion(region), tokens.domain),
    label: label || account.nickname || account.uid || 'workbuddy',
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAtMs: tokens.expiresInSec > 0 ? now + tokens.expiresInSec * 1000 : 0,
    refreshExpiresAtMs: tokens.expiresInSec > 0 ? now + 30 * 24 * 3600 * 1000 : undefined,
    uid: account.uid ?? '',
    nickname: account.nickname,
    enterpriseId: account.enterpriseId,
    domain: tokens.domain,
  }
}

/**
 * 用 refresh token 换一份新的访问令牌。
 * 返回可直接 patch 进账号库的字段。
 */
export async function refreshAccount(account) {
  const response = await fetch(`${CHAT_BASE[account.region]}/v2/plugin/auth/token/refresh`, {
    method: 'POST',
    headers: refreshHeaders(account),
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  })
  const envelope = await readEnvelope(response)
  if (!response.ok || envelope.code !== 0) {
    throw new Error(`刷新令牌失败（http ${response.status}, code ${envelope.code}）：${envelope.msg.slice(0, 160)}`)
  }
  const data = isObject(envelope.data) ? envelope.data : {}
  const accessToken = optionalString(data.accessToken)
  if (accessToken === undefined) {
    throw new Error('刷新令牌没有返回 accessToken，需要在浏览器里重新登录这个账号')
  }
  const now = Date.now()
  const patch = { accessToken }
  if (optionalString(data.refreshToken)) patch.refreshToken = data.refreshToken
  if (typeof data.expiresIn === 'number' && data.expiresIn > 0) {
    patch.expiresAtMs = now + data.expiresIn * 1000
    patch.refreshExpiresAtMs = now + 30 * 24 * 3600 * 1000
  }
  if (optionalString(data.domain)) patch.domain = data.domain
  return patch
}

/** 距过期不足该余量就刷新。上游实测 5 分钟足够，太早刷新浪费轮次。 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

/**
 * 保证访问令牌可用，返回刷新后的账号对象（不写库；写库由调用方决定）。
 * @param {(id: string, patch: object) => object|undefined} patchFn
 */
export async function ensureFresh(account, patchFn) {
  const expired = !account.expiresAtMs || account.expiresAtMs - Date.now() < REFRESH_MARGIN_MS
  if (!expired) return account
  if (!account.refreshToken) {
    throw new Error('访问令牌已过期且没有 refresh token，需要在浏览器里重新登录')
  }
  const patch = await refreshAccount(account)
  const next = { ...account, ...patch }
  patchFn?.(account.id, patch)
  return next
}

/**
 * 从外部 JSON 文件导入一个账号。
 *
 * 接受两种形状：
 * 1. 插件自己的存储（camelCase 的 expiresAtMs）
 * 2. 官方客户端 / 同类脚本导出的（snake/秒级 expiresAt）
 */
export function importAccountFromJson(raw, { region, label } = {}) {
  if (!isObject(raw)) throw new Error('导入文件不是 JSON 对象')
  const nested = isObject(raw.tokens) ? raw.tokens : raw
  const accessToken = optionalString(nested.accessToken) ?? optionalString(nested.access_token)
  if (!accessToken) throw new Error('导入文件里没有 accessToken')
  const refreshToken = optionalString(nested.refreshToken) ?? optionalString(nested.refresh_token) ?? ''
  const identity = isObject(raw.account) ? raw.account : raw
  const declaredRegion = region
    ? normalizeRegion(region)
    : regionOfDomain(optionalString(nested.domain) ?? optionalString(raw.domain) ?? '')
  const expiresAtMs = (() => {
    if (typeof nested.expiresAtMs === 'number' && nested.expiresAtMs > 0) return nested.expiresAtMs
    if (typeof nested.expiresAt === 'number' && nested.expiresAt > 0) {
      // 秒级时间戳（官方客户端用秒）；大于 1e12 的按毫秒处理。
      return nested.expiresAt > 1e12 ? nested.expiresAt : nested.expiresAt * 1000
    }
    return 0
  })()
  return {
    region: declaredRegion,
    label: label || optionalString(identity.nickname) || optionalString(identity.uid) || 'imported',
    accessToken,
    refreshToken,
    expiresAtMs,
    uid: optionalString(identity.uid) ?? '',
    nickname: optionalString(identity.nickname),
    enterpriseId: optionalString(identity.enterpriseId) ?? optionalString(identity.enterprise_id),
    domain: optionalString(nested.domain) ?? optionalString(raw.domain) ?? '',
  }
}

/** 在桌面环境打开一个 URL；失败不阻塞流程（用户可以自己复制链接）。 */
export function openExternal(url) {
  try {
    const [command, args] = process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch {
    return false
  }
}

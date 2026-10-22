/**
 * 宿主侧的 HTTP 接口：给设置卡片与看板读数据、执行动作。
 *
 * 两种守卫分别挡不同东西：回环 Host/Origin 挡 DNS 重绑定页面（请求会带着攻击者域名
 * 到达），进程内随机 key 挡本机其它进程——回环地址不是身份，任何本地程序都能伪造
 * `Host: 127.0.0.1`，而花钱的动作必须证明调用方拿到过这次响应里的 key。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { checkInAccount } from './checkin.js'
import { sweep } from './schedule.js'
import { collectStatus } from './summary.js'
import { deleteAccount, findAccount, listAccounts, patchAccount, readLog, readPins, upsertAccount, writePins } from './store.js'
import { accountFromLogin, beginLogin, forgetLogin, pollLogin } from './auth.js'
import { pluginConfigFile, readPluginConfig, visibleModelsOf } from './plugin-config.js'
import { DEFAULT_CHECKIN_MINUTE } from './schedule.js'
import { DEFAULT_STRATEGY, isStrategy } from './rotation.js'
import { aggregateUsage, normalizeUsageRange, readUsage, USAGE_WINDOW_DAYS } from './usage.js'

export const WEB_BASE_PATH = '/plugins/multi-credits-pool'

const STATE_CACHE_MS = 15_000
const BODY_LIMIT = 16 * 1024
const LOGIN_TTL_MS = 5 * 60_000

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(payload)
}

function hostIsLoopback(host) {
  if (typeof host !== 'string') return false
  const name = host.split(':')[0] ?? ''
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

/**
 * 从 URL 的 `?range=` 取看板时间档。
 *
 * 认不出的值交给 `normalizeUsageRange` 退回默认档，不报 400——档位是纯展示参数，
 * 为一个拼错的查询串让整页 500 更糟。
 */
function usageRangeOf(url) {
  try {
    return normalizeUsageRange(new URL(url ?? '/', 'http://127.0.0.1').searchParams.get('range') ?? undefined)
  } catch {
    return normalizeUsageRange(undefined)
  }
}

function originIsLoopback(origin) {
  if (origin === undefined) return true
  try {
    const url = new URL(origin)
    return hostIsLoopback(url.host)
  } catch {
    return false
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function keyMatches(expected, presented) {
  if (typeof presented !== 'string' || presented.length !== expected.length) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  return a.length === b.length && timingSafeEqual(a, b)
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 把内部行数据压成界面要的形状：不含任何令牌。 */
function toRows(status, cooldownOf) {
  return status.rows.map(row => {
    const cooldownUntil = typeof cooldownOf === 'function' ? cooldownOf(row.id) : undefined
    return {
      id: row.id,
      label: row.label,
      region: row.region,
      today: row.today.state,
      amount: row.today.amount,
      message: row.today.message,
      credits: row.credits,
      creditsTotal: row.totalSize,
      unlimited: row.unlimited === true,
      // 逐段积分：每段自己的剩余、总量与到期时刻，详情面板靠它画分段条与到期表。
      packages: (row.packages ?? []).map(toPackage),
      // 同名套餐的聚合，给概览行用；到期取该组最早的那一期。
      groups: (row.groups ?? []).map(group => ({
        name: group.name,
        remain: group.remain,
        size: group.size,
        count: group.count,
        unlimited: group.unlimited === true,
        endTime: group.endTime,
        endTimeMs: Number.isFinite(group.endTimeMs) ? group.endTimeMs : undefined,
      })),
      creditsExpireAtMs: Number.isFinite(row.creditsExpireAtMs) ? row.creditsExpireAtMs : undefined,
      enterprise: row.enterprise,
      nickname: row.nickname,
      kind: row.kind,
      uidSuffix: typeof row.uid === 'string' && row.uid !== '' ? row.uid.slice(-4) : undefined,
      expiresAtMs: row.expiresAtMs,
      lastCheckIn: row.lastCheckIn,
      cooldownUntil: Number.isFinite(cooldownUntil) && cooldownUntil > Date.now() ? cooldownUntil : undefined,
      error: row.error,
    }
  })
}

/**
 * 一段积分。
 *
 * 到期时刻同时给字符串与毫秒：字符串原样显示（上游就是这个时区的墙上时间），
 * 毫秒给排序与倒计时——让浏览器自己解析那个字符串会按本地时区偏几个小时。
 */
function toPackage(pkg) {
  return {
    name: pkg.packageName,
    code: pkg.packageCode,
    remain: pkg.remain,
    size: pkg.size,
    used: pkg.used,
    unlimited: pkg.unlimited === true,
    endTime: pkg.endTime,
    endTimeMs: Number.isFinite(pkg.endTimeMs) ? pkg.endTimeMs : undefined,
    startTime: pkg.startTime,
  }
}

/** 最近几条签到流水，带账号显示名，供看板底部的动态列表用。 */
function recentEntries(accounts, limit = 8) {
  const labels = new Map(accounts.map(account => [account.id, account.label]))
  return readLog()
    .filter(entry => entry.kind === 'checkin' || entry.status !== undefined)
    .slice(-limit)
    .reverse()
    .map(entry => ({
      at: entry.at,
      date: entry.date,
      accountId: entry.accountId,
      label: labels.get(entry.accountId) ?? entry.accountId,
      status: entry.status,
      amount: entry.amount,
    }))
}

/**
 * @param {{
 *   accountsOf: () => object[],
 *   logger?: object,
 *   configOf?: () => object,
 *   invalidate?: () => void,
 *   cooldownOf?: (accountId: string) => number | undefined,
 *   strategyOf?: () => string,
 *   onStrategyChange?: (strategy: string) => void,
 *   rotationState?: () => object,
 *   observe?: (accounts: object[]) => void,
 *   balanceSink?: (accountId: string, credits: number, expireAt: number) => void,
 *   pinsOf?: () => Record<string, string>,
 *   onPinChange?: (pins: Record<string, string>) => void,
 *   refreshModels?: () => Promise<object[]>,
 *   onModelsChange?: () => void,
 * }} options
 */
export function createWebApi(options) {
  const accountsOf = options.accountsOf
  const logger = options.logger
  const actionKey = randomBytes(24).toString('hex')
  const attempts = new Map()
  let cache = { at: 0, value: undefined }

  async function buildState(options = {}) {
    const now = Date.now()
    // 按时间看板的档位跟着请求走，所以缓存键里带上档位：同一档位 15 秒内复用，
    // 换档立刻重算，读的是同一份流水。
    const range = normalizeUsageRange(options.range)
    if (cache.value !== undefined && cache.range === range && now - cache.at < STATE_CACHE_MS) return cache.value
    const accounts = accountsOf()
    const status = await collectStatus(accounts, { balance: true })
    const config = readPluginConfig()
    const models = Array.isArray(config.models) ? config.models : []
    const hidden = new Set(Array.isArray(config.visibleModels) ? config.visibleModels : [])
    // 余额读数同时喂给轮换器：「优先过期」要看到期时间，「优先用完一个」要看余量。
    if (Array.isArray(status.rows)) {
      options.observe?.(status.rows)
      for (const row of status.rows) {
        if (typeof options.balanceSink !== 'function') break
        const expireAt = Number.isFinite(row.expiresAtMs) ? row.expiresAtMs : Number.POSITIVE_INFINITY
        options.balanceSink(row.id, typeof row.credits === 'number' ? row.credits : Number.POSITIVE_INFINITY, expireAt)
      }
    }
    const value = {
      actionKey,
      generatedAt: now,
      config: {
        autoCheckin: config.autoCheckin !== false,
        minuteOfDay: Number.isInteger(config.minuteOfDay) ? config.minuteOfDay : DEFAULT_CHECKIN_MINUTE,
        models: models.length,
        providerId: config.providerId,
        displayName: config.displayName,
        port: config.port,
        strategy: options.strategyOf?.() ?? config.strategy ?? DEFAULT_STRATEGY,
        // 模型可见性：清单给勾选框，visibleModels 是已勾上的集合，lastRefresh 是上次抓上游的时刻。
        catalog: models.map(model => ({
          id: model.id,
          name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
          maxTokens: Number.isInteger(model.maxTokens) ? model.maxTokens : undefined,
          contextWindow: Number.isInteger(model.contextWindow) ? model.contextWindow : undefined,
        })),
        visibleModels: visibleModelsOf(config).map(model => model.id),
        lastRefresh: Number.isInteger(config.catalogAt) ? config.catalogAt : 0,
      },
      // 把这一轮的行数据一起给出去：轮换器要按它排出「下一次会先用谁」。
      rotation: options.rotationState?.(status.rows),
      // 对话固定：键是会话标识（`prompt_cache_key:<sessionId>`），值是账号 id。
      pins: options.pinsOf?.() ?? readPins(),
      usage: aggregateUsage(readUsage(), { days: USAGE_WINDOW_DAYS, now, range }),
      status: {
        date: status.date,
        month: status.month,
        totals: status.totals,
        rows: toRows(status, options.cooldownOf),
      },
      recent: recentEntries(accounts),
    }
    cache = { at: now, value, range }
    return value
  }

  const dropCache = () => {
    cache = { at: 0, value: undefined, range: undefined }
    options.invalidate?.()
  }

  async function runAction(body) {
    const action = body?.action
    switch (action) {
      case 'checkin': {
        const accountId = typeof body.id === 'string' ? body.id : undefined
        if (accountId === undefined) {
          const stats = await sweep({ force: true, minuteOfDay: 0, quiet: true })
          return { ok: true, stats }
        }
        const account = findAccount(accountId)
        if (account === undefined) return { ok: false, message: `没有账号 ${accountId}` }
        const result = await checkInAccount(account)
        return { ok: true, result: { accountId: result.accountId, status: result.status, amount: result.amount, message: result.message } }
      }
      case 'login-start': {
        const region = body.region === 'global' ? 'global' : 'cn'
        const started = await beginLogin(region)
        attempts.set(started.state, { ...started, at: Date.now() })
        return { ok: true, state: started.state, authUrl: started.authUrl, region: started.region }
      }
      case 'login-poll': {
        const track = attempts.get(String(body.state ?? ''))
        if (track === undefined) return { ok: false, message: '这次登录已失效，请重新发起' }
        if (Date.now() - track.at > LOGIN_TTL_MS) {
          attempts.delete(track.state)
          forgetLogin(track.state)
          return { ok: false, message: '登录等待超时，请重新发起' }
        }
        const polled = await pollLogin(track)
        if (polled.status !== 'complete') return { ok: true, status: 'pending' }
        const account = accountFromLogin({
          region: track.region,
          tokens: polled.tokens,
          account: polled.account,
          label: typeof body.label === 'string' && body.label !== '' ? body.label : undefined,
        })
        const stored = upsertAccount(account)
        attempts.delete(track.state)
        forgetLogin(track.state)
        dropCache()
        return { ok: true, status: 'complete', account: { id: stored.id ?? account.id ?? account.uid, label: stored.label ?? account.label, region: stored.region ?? account.region } }
      }
      case 'rename': {
        const account = findAccount(String(body.id ?? ''))
        if (account === undefined) return { ok: false, message: '没有这个账号' }
        const label = String(body.label ?? '').trim()
        if (label === '') return { ok: false, message: '账号名不能为空' }
        patchAccount(account.id, { label })
        dropCache()
        return { ok: true }
      }
      case 'remove': {
        const account = findAccount(String(body.id ?? ''))
        if (account === undefined) return { ok: false, message: '没有这个账号' }
        deleteAccount(account.id)
        dropCache()
        return { ok: true }
      }
      case 'config': {
        const config = readPluginConfig()
        const next = { ...config }
        if (typeof body.autoCheckin === 'boolean') next.autoCheckin = body.autoCheckin
        if (Number.isInteger(body.minuteOfDay) && body.minuteOfDay >= 0 && body.minuteOfDay < 1440) {
          next.minuteOfDay = body.minuteOfDay
        }
        writeFileSync(pluginConfigFile(), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
        dropCache()
        return { ok: true, config: { autoCheckin: next.autoCheckin !== false, minuteOfDay: next.minuteOfDay ?? DEFAULT_CHECKIN_MINUTE, strategy: next.strategy ?? DEFAULT_STRATEGY } }
      }
      case 'visible-models': {
        const requested = Array.isArray(body.visible) ? body.visible.filter(id => typeof id === 'string' && id !== '') : undefined
        if (requested === undefined) return { ok: false, message: '缺少要显示的模型清单' }
        const config = readPluginConfig()
        const known = new Set((Array.isArray(config.models) ? config.models : []).map(model => model.id))
        const shown = requested.filter(id => known.has(id))
        if (shown.length === 0) return { ok: false, message: '至少要留一个模型，否则模型选择器会空掉' }
        // 存的是「勾掉的」：清单刷新后新出现的模型自动可见，不用用户重新点一遍。
        const hidden = [...known].filter(id => !shown.includes(id))
        writeFileSync(pluginConfigFile(), `${JSON.stringify({ ...config, visibleModels: hidden }, null, 2)}\n`, 'utf8')
        options.onModelsChange?.()
        dropCache()
        return { ok: true, visibleModels: visibleModelsOf({ ...config, visibleModels: hidden }).map(model => model.id) }
      }
      case 'refresh-models': {
        try {
          const models = await options.refreshModels?.()
          if (!Array.isArray(models) || models.length === 0) return { ok: false, message: '上游没有返回可用的模型' }
          options.onModelsChange?.()
          dropCache()
          return { ok: true, models: models.length }
        } catch (error) {
          return { ok: false, message: messageOf(error) }
        }
      }
      case 'strategy': {
        const strategy = String(body.strategy ?? '')
        if (!isStrategy(strategy)) return { ok: false, message: `未知模式：${strategy}` }
        const config = readPluginConfig()
        writeFileSync(pluginConfigFile(), `${JSON.stringify({ ...config, strategy }, null, 2)}\n`, 'utf8')
        options.onStrategyChange?.(strategy)
        dropCache()
        return { ok: true, strategy }
      }
      case 'pin': {
        const conversationId = String(body.conversationId ?? '')
        if (conversationId === '') return { ok: false, message: '缺少对话标识' }
        const account = findAccount(String(body.id ?? ''))
        if (account === undefined) return { ok: false, message: '没有这个账号' }
        const pins = { ...(options.pinsOf?.() ?? readPins()), [conversationId]: account.id }
        writePins(pins)
        options.onPinChange?.(pins)
        dropCache()
        return { ok: true, pins, pinned: { conversationId, accountId: account.id, label: account.label } }
      }
      case 'unpin': {
        const conversationId = String(body.conversationId ?? '')
        if (conversationId === '') return { ok: false, message: '缺少对话标识' }
        const pins = { ...(options.pinsOf?.() ?? readPins()) }
        delete pins[conversationId]
        writePins(pins)
        options.onPinChange?.(pins)
        dropCache()
        return { ok: true, pins }
      }
      default:
        return { ok: false, message: `未知动作：${String(action)}` }
    }
  }

  async function handleState(req, res) {
    if (!hostIsLoopback(req.headers.host)) return json(res, 403, { error: 'Host 必须是回环地址' })
    try {
      const range = usageRangeOf(req.url)
      return json(res, 200, await buildState({ range }))
    } catch (error) {
      logger?.error?.('[multi-credits-pool] 读取状态失败', error)
      return json(res, 500, { error: messageOf(error) })
    }
  }

  async function handleAction(req, res) {
    if (!hostIsLoopback(req.headers.host)) return json(res, 403, { error: 'Host 必须是回环地址' })
    if (!originIsLoopback(req.headers.origin)) return json(res, 403, { error: 'Origin 必须是回环地址' })
    if (!keyMatches(actionKey, req.headers['x-credits-key'])) return json(res, 401, { error: '缺少或错误的动作 key' })
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch (error) {
      return json(res, 400, { error: `请求体不是合法 JSON：${messageOf(error)}` })
    }
    try {
      const result = await runAction(body)
      return json(res, result.ok === false ? 400 : 200, result)
    } catch (error) {
      logger?.error?.('[multi-credits-pool] 动作失败', error)
      return json(res, 500, { error: messageOf(error) })
    }
  }

  return { actionKey, handleState, handleAction }
}

/**
 * 挂到宿主的 webServer 上。没有 webServer 的宿主（纯 CLI）会跳过，插件其余功能不受影响。
 */
export function registerWebApi(ctx, options) {
  const api = createWebApi(options)
  const mounts = [
    { kind: 'exact', path: `${WEB_BASE_PATH}/state`, handler: api.handleState },
    { kind: 'exact', path: `${WEB_BASE_PATH}/action`, handler: api.handleAction },
  ]
  const disposes = []
  for (const mount of mounts) {
    const dispose = ctx.webServer.register(mount)
    if (typeof dispose === 'function') disposes.push(dispose)
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposes) {
        try {
          dispose()
        } catch {
          // 卸挂失败不影响进程退出
        }
      }
    }, 'multi-credits-pool: Web 接口')
  }
  return api
}

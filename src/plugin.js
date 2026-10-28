/**
 * 宿主插件入口：把多账号轮换注册成宿主 `llm` 服务的一个原生 provider。
 *
 * 与上一版的区别是这一版不再起本地代理。旧做法是在回环端口上开一个 OpenAI 兼容
 * 端点，再把它的地址写进宿主 `llm-pi-ai` 的设置里当一个 provider——请求要绕一圈
 * HTTP，端口固定、密钥共享、还要在宿主设置里留一条指向死端口的条目。现在适配器
 * 直接实现宿主的 `LlmAdapter` 契约，用 `ctx.llm.registerAdapter()` 挂上去，模型
 * 选择器里照样出现「multi-credits-pool」，但中间没有任何端口。
 *
 * 与宿主之间只有两样契约：`llm` 服务的适配器注册接口，以及 `webServer`（可选，
 * 给设置看板用）。不 import 任何宿主包，插件可以独立在本机跑自测。
 */
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CreditsPoolAdapter } from './adapter.js'
import { AccountRotator } from './rotation.js'
import { listAccounts, patchAccount, readPins } from './store.js'
import { ensureFresh } from './auth.js'
import { dataDir } from './paths.js'
import { readPluginConfig, peekPluginConfig, visibleModelsOf, writeModelCatalog } from './plugin-config.js'
import { fetchModelCatalog } from './model-catalog.js'
import { sweep } from './schedule.js'
import { registerWebApi } from './web-routes.js'
import { isPastUtc8Time } from './protocol.js'
import { checkedInToday } from './store.js'
import { appendUsage } from './usage.js'

export const name = 'llm-multi-credits-pool'

/**
 * 只依赖 `llm`。
 *
 * cordis 对服务访问有硬约束：没声明 inject 就读 `ctx.llm` 会直接抛
 * `cannot get property "llm" without inject`，插件当场初始化失败。声明成注入
 * 依赖后，宿主没提供 llm 时插件挂 pending 而不是报错。
 *
 * `webServer` 不在这里声明：它是可选能力，用 `ctx.inject()` 嵌套一个子 fiber 去
 * 拿。声明成硬依赖会让没有 webServer 的组合（CLI）整个插件都起不来。
 */
export const inject = ['llm']

/**
 * 启动痕迹：宿主加载本模块、以及调用 apply，各写一行。插件起不来时先看这个
 * 文件——没有 module 行说明包没被导入，有 module 没 apply 说明注入的服务没就绪。
 */
function trace(stage) {
  try {
    mkdirSync(dataDir(), { recursive: true })
    appendFileSync(join(dataDir(), 'boot.log'), `${new Date().toISOString()} ${stage} pid=${process.pid}\n`)
  } catch {
    // 痕迹写不下去不影响插件本身
  }
}

trace('module-loaded')

function pickLogger(ctx) {
  const candidate = ctx?.logger ?? ctx?.get?.('logger')
  if (candidate && typeof candidate.warn === 'function') return candidate
  return console
}

/**
 * 上游清单的刷新间隔：一天一次。
 *
 * 模型的上下线是上游按周算的节奏，一天一次足够及时；每次刷新只发一个 GET，
 * 不占对话额度。失败不重试——下一个周期自然还会再试一次。
 */
export const CATALOG_REFRESH_MS = 24 * 60 * 60_000

/**
 * 首次刷新的等待时间：启动时先让 provider 正常登记，再在后台补一次清单。
 *
 * 不放在登记前等，是因为网络慢时会把启动拖到十几秒，模型选择器空着更糟：
 * 先用文件里的缓存登记，刷新成功后再换掉适配器的清单。
 */
export const CATALOG_FIRST_DELAY_MS = 15_000

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 插件主函数。异常一律吞掉并记日志：插件起不来时宿主必须照常可用，
 * 用户只是看不到「multi-credits-pool」这一个 provider。
 */
export function apply(ctx) {
  trace('apply-entered')
  try {
    return applyInner(ctx)
  } catch (error) {
    const message = `[multi-credits-pool] 初始化失败：${errorText(error)}`
    trace(`apply-failed ${message}`)
    pickLogger(ctx).error?.(message)
    console.error(message)
    return undefined
  }
}

function applyInner(ctx) {
  const logger = pickLogger(ctx)
  const llm = ctx?.llm
  if (llm === undefined || typeof llm.registerAdapter !== 'function') {
    const message = '[multi-credits-pool] 宿主没有提供 llm 服务，provider 不会被登记'
    trace('llm-missing')
    logger.warn?.(message)
    return undefined
  }

  const config = readPluginConfig()
  const rotator = new AccountRotator({ strategy: config.strategy })
  // 手动固定的对话在重启后要还在：从落盘表里恢复，坏数据按空表处理。
  rotator.restorePins(readPins())

  /**
   * 当前生效的配置：进程启动读的那一份，清单刷新或勾选变更后换成新的。
   *
   * 适配器的模型清单从这里取，保证 `/v1/models` 与登记出去的那份是同一套模型。
   */
  let live = config

  const adapter = new CreditsPoolAdapter({
    accountsOf: () => listAccounts(),
    rotator,
    modelsOf: () => visibleModelsOf(live),
    prepareAccount: account => ensureFresh(account, (id, patch) => patchAccount(id, patch)),
    onUsage: entry => appendUsage(entry),
    onFailure: ({ shape, body, message }) => {
      // 上游的「非法调用」只看得出请求体不对，正文又不能写进日志：形状进 boot.log，
      // 整份请求体落到 rejected.json，事后能拿真身去复现，不用靠猜。
      trace(`chat-rejected shape=${shape} status=400 ${message}`)
      // 同一秒里会有两条被拒请求，直接覆盖写会互相截断，写临时文件再改名。
      const target = join(dataDir(), 'rejected.json')
      const draft = `${target}.tmp`
      const record = { at: new Date().toISOString(), shape, message, body }
      writeFileSync(draft, JSON.stringify(record))
      renameSync(draft, target)
    },
    providerId: config.providerId,
    displayName: config.displayName,
    defaultContextWindow: config.defaultContextWindow,
    defaultMaxTokens: config.defaultMaxTokens,
    logger,
  })

  // 注册路由。重复注册同一个路由会以 DUPLICATE_ADAPTER 失败，所以只在启动时注册
  // 一次；之后换模型清单只是换适配器读的那份数据，不需要重新注册。
  const registration = llm.registerAdapter([config.providerId], adapter)
  trace(`adapter-registered ${config.providerId} models=${visibleModelsOf(live).length}`)
  logger.info?.(
    `[multi-credits-pool] provider ${config.providerId} 已注册，${visibleModelsOf(live).length} 个模型`,
  )

  /**
   * 让宿主的模型选择器跟着清单变化。
   *
   * 适配器的 `listModels` 每次被问都读 `live`，所以换掉 `live` 之后宿主下次问就是
   * 新清单。这里再发一次拓扑变更事件，让已经打开的选择器立刻重读，而不是等用户
   * 关掉再打开。
   */
  const announce = () => {
    try {
      registration.replace([config.providerId])
    } catch (error) {
      logger.warn?.(`[multi-credits-pool] 通知宿主刷新模型清单失败：${errorText(error)}`)
    }
  }

  let disposed = false
  let autoRunning = false

  /**
   * 进程内自动签到：DSH 开着时到点签一次，启动时补当天。
   *
   * 每分钟看一次开关与签到时刻，用不落盘的 {@link peekPluginConfig} 读配置——设置
   * 卡片改完立刻生效，不需要重启。已经在今天签过的账号由 sweep 自己跳过。
   */
  const autoCheckin = async () => {
    if (disposed || autoRunning) return
    const current = peekPluginConfig()
    if (current.autoCheckin === false) return
    const minuteOfDay = Number.isInteger(current.minuteOfDay) ? current.minuteOfDay : 600
    if (!isPastUtc8Time(minuteOfDay)) return
    const accounts = listAccounts()
    if (accounts.length === 0) return
    if (accounts.every(account => checkedInToday(account.id))) return
    autoRunning = true
    try {
      const stats = await sweep({ minuteOfDay, catchUp: true, quiet: true })
      trace(`auto-checkin ${JSON.stringify(stats)}`)
    } catch (error) {
      logger.warn?.(`[multi-credits-pool] 自动签到失败：${errorText(error)}`)
    } finally {
      autoRunning = false
    }
  }

  const autoTimer = setInterval(() => void autoCheckin(), 60_000)
  if (typeof autoTimer.unref === 'function') autoTimer.unref()
  void autoCheckin()

  /**
   * 策略热更新：设置卡片改完策略立刻生效，不需要重启。
   */
  const syncStrategy = () => {
    rotator.setStrategy(peekPluginConfig().strategy)
  }
  const strategyTimer = setInterval(syncStrategy, 60_000)
  if (typeof strategyTimer.unref === 'function') strategyTimer.unref()

  /**
   * 刷新上游模型清单：拿一个可用账号的身份去问服务端，把结果写回 plugin.json。
   *
   * 身份只用来过网关的鉴权，与「谁出账」无关；没有账号就直接跳过——连不上上游时
   * 清单保持原样，模型选择器仍是上次那份，不会突然空掉。
   */
  const refreshCatalog = async ({ quiet = false } = {}) => {
    if (disposed) return undefined
    const accounts = listAccounts()
    if (accounts.length === 0) {
      trace('catalog-skipped no-account')
      return undefined
    }
    const region = peekPluginConfig().catalogRegion === 'global' ? 'global' : 'cn'
    const credential = await ensureFresh(accounts[0], (id, patch) => patchAccount(id, patch))
    const models = await fetchModelCatalog(credential, { region })
    if (!Array.isArray(models) || models.length === 0) return undefined
    live = writeModelCatalog(models, { region, nowMs: Date.now() })
    trace(`catalog-refreshed models=${models.length} region=${region}`)
    if (!quiet) logger.info?.(`[multi-credits-pool] 模型清单已更新（${models.length} 个）`)
    announce()
    return models
  }

  /** 只跑一次、失败不抛的后台刷新：定时器与启动各调一次。 */
  const refreshCatalogQuietly = async () => {
    try {
      await refreshCatalog({ quiet: true })
    } catch (error) {
      trace(`catalog-failed ${errorText(error)}`)
    }
  }

  const catalogFirstTimer = setTimeout(() => void refreshCatalogQuietly(), CATALOG_FIRST_DELAY_MS)
  if (typeof catalogFirstTimer.unref === 'function') catalogFirstTimer.unref()
  const catalogTimer = setInterval(() => void refreshCatalogQuietly(), CATALOG_REFRESH_MS)
  if (typeof catalogTimer.unref === 'function') catalogTimer.unref()

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], webCtx => {
        registerWebApi(webCtx, {
          accountsOf: () => listAccounts(),
          logger,
          refreshModels: () => refreshCatalog({ quiet: true }),
          onModelsChange: () => {
            // 勾选变了就换掉适配器读的那份清单，再通知宿主重读。
            live = readPluginConfig()
            announce()
          },
          cooldownOf: accountId => rotator.snapshot().cooldownUntil[accountId],
          strategyOf: () => rotator.strategy,
          onStrategyChange: strategy => {
            rotator.setStrategy(strategy)
          },
          rotationState: rows => ({
            strategy: rotator.strategy,
            boundConversations: rotator.snapshot().bindings,
            // 下一次请求会依次尝试的账号。看板据此给第一个打「下一个出账」、
            // 其余的标顺位——用户不用猜现在是谁在出账。
            preview: Array.isArray(rows) ? rotator.order(rows).map(row => row.id) : [],
          }),
          observe: accounts => rotator.observe(accounts),
          balanceSink: (accountId, credits, expireAt) => rotator.noteBalance(accountId, credits, undefined, expireAt),
          pinsOf: () => rotator.listPins(),
          onPinChange: pins => rotator.setPins(pins),
        })
        trace('web-api-registered')
      })
    } catch (error) {
      logger.warn?.(`[multi-credits-pool] 注册 Web 接口失败：${errorText(error)}`)
    }
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    clearInterval(autoTimer)
    clearInterval(strategyTimer)
    clearInterval(catalogTimer)
    clearTimeout(catalogFirstTimer)
    // 注册随 fiber 一起注销，这里不用手写 removeAdapter：宿主在 fiber dispose 时
    // 会把这条路由连同它的适配器一起摘掉。
  }

  if (typeof ctx.effect === 'function') ctx.effect(() => () => dispose())
  else if (typeof ctx.on === 'function') ctx.on('dispose', () => dispose())

  return registration
}

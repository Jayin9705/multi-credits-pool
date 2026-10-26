/**
 * 宿主插件自己的配置：数据目录里的 plugin.json。
 *
 * 插件不向宿主注册 Config schema（避免引入 schemastery 依赖），所以端口、
 * provider id、模型清单都从这个文件读；文件缺失时用下面这份缺省值并原样写出来，
 * 让用户装了就能改。
 *
 * `models` 是上游清单的缓存：运行时按天从服务端刷新（见 model-catalog.js），
 * 文件里的 `CN_MODELS` 只是首启、离线时的兜底。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { dataDir } from './paths.js'
import { DEFAULT_STRATEGY, isStrategy } from './rotation.js'
import { fillKnownEfforts, reasoningEffortsOf } from './reasoning.js'

/**
 * 兜底清单里的等级声明：上游给的是 `supportedEfforts` 数组，登记给宿主时写成
 * `{ 档位: 档位 }`，请求体里的 `reasoning_effort` 就用这个原值。
 */
function efforts(...levels) {
  return reasoningEffortsOf({ supportedEfforts: levels })
}

export const PLUGIN_CONFIG_BASENAME = 'plugin.json'

/**
 * 固定端口：provider 的 baseURL 要写进宿主配置，端口每次重启都变会让已保存的
 * provider 指向死地址。端口被占用时代理会退回随机端口并改写 host 侧配置。
 */
export const DEFAULT_PLUGIN_PORT = 34610

/**
 * 兜底模型清单：首启还没联网、或某次刷新失败又没有缓存时用它。
 *
 * 内容按上游 2026-10 的 CLI 清单校准过，不等于最新——真正的来源是
 * {@link fetchModelCatalog} 每天拉的那份，这里只保证模型选择器不会空着。
 */
export const CN_MODELS = [
  { id: 'auto', name: 'Auto', contextWindow: 256_000, maxTokens: 32_000, reasoningEfforts: efforts('high') },
  { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 960_000, maxTokens: 64_000, reasoningEfforts: efforts('high') },
  { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxTokens: 64_000, reasoningEfforts: efforts('high') },
  { id: 'step-5-preview', name: 'Step-5-Preview', contextWindow: 1_000_000, maxTokens: 64_000, reasoningEfforts: efforts('low', 'medium', 'high') },
  { id: 'space-bunny', name: 'Space-Bunny', contextWindow: 1_000_000, maxTokens: 128_000, reasoningEfforts: efforts('low', 'medium', 'high', 'xhigh', 'max') },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, maxTokens: 128_000, reasoningEfforts: efforts('low', 'high', 'max') },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 64_000, reasoningEfforts: efforts('low', 'high', 'max') },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, maxTokens: 131_072, reasoningEfforts: efforts('low', 'high', 'max') },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 64_000, reasoningEfforts: efforts('medium') },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, maxTokens: 48_000, reasoningEfforts: efforts('medium') },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', contextWindow: 200_000, maxTokens: 64_000, reasoningEfforts: efforts('medium') },
  { id: 'kimi-k3-1', name: 'Kimi-K3', contextWindow: 1_000_000, maxTokens: 32_000, reasoningEfforts: efforts('medium') },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, maxTokens: 64_000, reasoningEfforts: efforts('low', 'high', 'max') },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', contextWindow: 256_000, maxTokens: 32_000, reasoningEfforts: efforts('medium') },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, maxTokens: 32_000, reasoningEfforts: efforts('medium') },
  { id: 'minimax-m3.1-flash', name: 'MiniMax-M3.1-Flash', contextWindow: 1_000_000, maxTokens: 128_000, reasoningEfforts: efforts('low', 'medium', 'high', 'xhigh', 'max') },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 512_000, maxTokens: 64_000, reasoningEfforts: efforts('medium') },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1_000_000, maxTokens: 128_000, reasoningEfforts: efforts('low', 'high', 'max') },
  { id: 'mimo-v2.6-pro', name: 'Xiaomi MiMo-V2.6-Pro', contextWindow: 1_000_000, maxTokens: 128_000, reasoningEfforts: efforts('high') },
]

/** 国际站 CLI 模型清单。 */
export const GLOBAL_MODELS = [
  { id: 'default-model', name: 'Auto', contextWindow: 176_000, maxTokens: 24_000, reasoningEfforts: efforts('high') },
  { id: 'fast-model', name: 'Fast', contextWindow: 200_000, maxTokens: 32_000, reasoningEfforts: efforts('medium') },
  { id: 'balanced-model', name: 'Balanced', contextWindow: 256_000, maxTokens: 32_000, reasoningEfforts: efforts('medium') },
  { id: 'primary-model', name: 'Primary', contextWindow: 272_000, maxTokens: 72_000, reasoningEfforts: efforts('medium') },
  { id: 'deep-model', name: 'Deep', contextWindow: 176_000, maxTokens: 24_000, reasoningEfforts: efforts('high') },
]

/** 旧版本用过的显示名，读到就换成现名，避免老 plugin.json 把旧名字带回来。 */
const LEGACY_DISPLAY_NAMES = new Set(['WorkBuddy \u591a\u8d26\u53f7'])

/** 旧版本登记过的 provider id：启动时顺手删掉，免得模型选择器里留一条死条目。 */
export const LEGACY_PROVIDER_IDS = ['workbuddy-multi']

/** 缺省配置：照兜底清单登记，端口固定，账号按对话固定。 */
export function defaultPluginConfig() {
  return {
    providerId: 'multi-credits-pool',
    displayName: 'multi-credits-pool',
    port: DEFAULT_PLUGIN_PORT,
    defaultContextWindow: 200_000,
    defaultMaxTokens: 64_000,
    models: CN_MODELS,
    // 空集合表示「全部登记」；用户在自动化里勾掉的模型进这里。
    visibleModels: [],
    catalogAt: 0,
    secret: '',
    strategy: DEFAULT_STRATEGY,
  }
}

/**
 * 登记给宿主的模型清单：缓存里剔除用户勾掉的，但至少留一个。
 *
 * 全部勾掉会让 provider 没有任何模型可挂，宿主那边的模型选择器直接空掉——
 * 这种状态下退回完整清单，比给出一个点不动的空列表好。
 */
export function visibleModelsOf(config) {
  const all = Array.isArray(config?.models) ? config.models : []
  const hidden = new Set(Array.isArray(config?.visibleModels) ? config.visibleModels : [])
  const shown = hidden.size === 0 ? all : all.filter(model => !hidden.has(model.id))
  return shown.length > 0 ? shown : all
}

/**
 * 把刷新到的上游清单写回 plugin.json。
 *
 * `visibleModels` 里已经不存在于新清单的 id 顺手清掉：模型的 id 上下线之后，
 * 留着一个永远匹配不上的隐藏项，用户在下一次勾选时会被它绕进去。
 */
export function writeModelCatalog(models, { file = pluginConfigFile(), region = 'cn', nowMs = Date.now() } = {}) {
  const config = readPluginConfig(file)
  const ids = new Set(models.map(model => model.id))
  const next = {
    ...config,
    models,
    visibleModels: (Array.isArray(config.visibleModels) ? config.visibleModels : []).filter(id => ids.has(id)),
    catalogRegion: region,
    catalogAt: nowMs,
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

export function pluginConfigFile() {
  return process.env.MULTI_CREDITS_POOL_CONFIG ?? join(dataDir(), PLUGIN_CONFIG_BASENAME)
}

/**
 * 只读地取配置：不落盘。
 *
 * 调度器每分钟都要看一眼开关与签到时刻，用会写文件的 {@link readPluginConfig}
 * 会把 plugin.json 变成每分钟一次写入。
 */
export function peekPluginConfig(file = pluginConfigFile()) {
  const defaults = defaultPluginConfig()
  let stored = {}
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed
    } catch {
      return defaults
    }
  }
  const merged = { ...defaults, ...stored }
  if (!Array.isArray(merged.models) || merged.models.length === 0) merged.models = defaults.models
  // 老缓存里没有推理等级声明：按已知 id 补一份，免得升级后要等下一次清单刷新
  // 才能在模型选择器里看到档位。
  merged.models = fillKnownEfforts(merged.models)
  if (typeof merged.secret !== 'string' || merged.secret.length < 16) merged.secret = defaults.secret
  merged.providerId = providerIdOf(merged.providerId, defaults.providerId)
  merged.displayName = displayNameOf(merged.displayName, defaults.displayName)
  if (!isStrategy(merged.strategy)) merged.strategy = defaults.strategy
  return merged
}

/** provider id：空值或改名前的 id 一律换成缺省 id。 */
function providerIdOf(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback
  const trimmed = value.trim()
  if (LEGACY_PROVIDER_IDS.includes(trimmed)) return fallback
  return trimmed
}

/** 显示名：空值回退到缺省名，旧名迁移到现名。 */
function displayNameOf(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback
  if (LEGACY_DISPLAY_NAMES.has(value.trim())) return fallback
  return value.trim()
}

/**
 * 读配置：文件里的字段覆盖缺省值，数组字段整体替换。
 * 首次运行会把合并后的结果写回文件，并生成一个代理 Bearer 密钥持久化。
 */
export function readPluginConfig(file = pluginConfigFile()) {
  const defaults = defaultPluginConfig()
  let stored = {}
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed
    } catch (error) {
      throw new Error(`${file} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const merged = { ...defaults, ...stored }
  if (!Array.isArray(merged.models) || merged.models.length === 0) merged.models = defaults.models
  merged.models = fillKnownEfforts(merged.models)
  if (!Array.isArray(merged.visibleModels)) merged.visibleModels = defaults.visibleModels
  merged.visibleModels = merged.visibleModels.filter(id => typeof id === 'string' && id !== '')
  if (!Number.isInteger(merged.catalogAt) || merged.catalogAt < 0) merged.catalogAt = 0
  if (typeof merged.catalogRegion !== 'string' || merged.catalogRegion === '') merged.catalogRegion = 'cn'
  merged.providerId = providerIdOf(merged.providerId, defaults.providerId)
  if (!Number.isInteger(merged.port) || merged.port < 0 || merged.port > 65_535) merged.port = defaults.port
  if (typeof merged.secret !== 'string' || merged.secret.length < 16) merged.secret = randomBytes(24).toString('base64url')
  merged.displayName = displayNameOf(merged.displayName, defaults.displayName)
  if (!isStrategy(merged.strategy)) merged.strategy = defaults.strategy

  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  return merged
}

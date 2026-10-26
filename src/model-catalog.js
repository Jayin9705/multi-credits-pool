/**
 * 上游模型清单：从服务端读当前可用的模型，替代写死的常量表。
 *
 * 官方 CLI 自己吃的就是这份文档（`/console/enterprises/personal/models`，国际站是
 * `/v3/config`），它有两段：
 *
 * - `data.models`：每个模型的元数据（`maxInputTokens` / `maxOutputTokens` / 名称 /
 *   是否禁用 / `reasoning` 能力声明等）。
 * - `data.agents[]` 里 `name === 'cli'` 那一条的 `models` 数组：CLI 真正可用的模型 id，
 *   且带顺序。顺序是产品排定的推荐次序，不该按字母或对象键序重排。
 *
 * 所以以 `agents.cli.models` 为准、用 `data.models` 补齐细节；`data.models` 里多出来的
 * 模型不属于 CLI 通道，不登记。
 */
import { chatBaseOf, chatHeaders, JSON_TIMEOUT_MS, stripBom } from './protocol.js'
import { reasoningEffortsOf } from './reasoning.js'

/** 官方 CLI 的模型清单地址：国内站与其它站的路径不同。 */
export const CATALOG_PATH = {
  cn: '/console/enterprises/personal/models',
  global: '/v3/config',
}

/** 上游把某个模型置为不可用时给的标记。 */
const DISABLED_FLAG = 'disabled'

/** 缺 input/output 上限的模型填不了 provider 的 `maxTokens`，直接跳过。 */
function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取 `agents` 里 CLI 通道的 id 列表；没有就返回空数组。 */
function cliModelIds(data) {
  const agents = Array.isArray(data.agents) ? data.agents : []
  for (const agent of agents) {
    if (!isObject(agent) || agent.name !== 'cli') continue
    const ids = Array.isArray(agent.models) ? agent.models.filter(id => typeof id === 'string' && id !== '') : []
    return ids
  }
  return []
}

/**
 * 把上游文档解析成 provider 的模型清单。
 *
 * 解析失败（没有 CLI 段、或过滤后为空）返回 `undefined`，让调用方保留上一份清单——
 * 上游改版时退回旧数据，比把模型选择器清空好。
 */
export function parseModelCatalog(document) {
  const data = isObject(document) ? document : {}
  const ids = cliModelIds(data)
  if (ids.length === 0) return undefined
  const raw = Array.isArray(data.models) ? data.models : []
  const byId = new Map()
  for (const entry of raw) {
    if (!isObject(entry)) continue
    if (typeof entry.id !== 'string' || entry.id === '') continue
    if (entry[DISABLED_FLAG] === true) continue
    const contextWindow = positive(entry.maxInputTokens) ? entry.maxInputTokens : 0
    const maxTokens = positive(entry.maxOutputTokens) ? entry.maxOutputTokens : 0
    if (contextWindow <= 0 || maxTokens <= 0) continue
    const efforts = reasoningEffortsOf(entry.reasoning)
    byId.set(entry.id, {
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id,
      contextWindow,
      maxTokens,
      // 没有档位声明的模型不带这个字段：宿主看到空字典会判配置非法。
      ...(efforts === undefined ? {} : { reasoningEfforts: efforts }),
    })
  }
  const models = []
  for (const id of ids) {
    const model = byId.get(id)
    if (model !== undefined) models.push(model)
  }
  return models.length > 0 ? models : undefined
}

/**
 * 读一次上游模型清单。
 *
 * `credential` 拿来拼鉴权头；`region` 决定打哪个路径。失败抛错，由调用方决定回退。
 */
export async function fetchModelCatalog(credential, options = {}) {
  const region = options.region ?? credential?.region ?? 'cn'
  const base = chatBaseOf(region)
  const path = CATALOG_PATH[region] ?? CATALOG_PATH.cn
  const response = await fetch(base + path, {
    method: 'GET',
    headers: { ...chatHeaders(credential), Accept: 'application/json' },
    signal: AbortSignal.timeout(options.timeoutMs ?? JSON_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`模型清单返回 HTTP ${response.status}`)
  const text = stripBom(await response.text())
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch (error) {
    throw new Error(`模型清单不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  if (isObject(envelope) && typeof envelope.code === 'number' && envelope.code !== 0) {
    throw new Error(`模型清单被拒：${envelope.code} ${typeof envelope.msg === 'string' ? envelope.msg : ''}`.trim())
  }
  const models = parseModelCatalog(isObject(envelope) && isObject(envelope.data) ? envelope.data : envelope)
  if (models === undefined) throw new Error('模型清单里没有可用的 CLI 模型')
  return models
}

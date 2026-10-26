/**
 * 推理等级：把上游给的能力声明折成 provider 配置里的 `reasoningEfforts`。
 *
 * 宿主（`@deepseek-ai/dsh-llm-pi-ai`）只认两种写法：`false` 表示这个模型没有推理，
 * 或者一个 `{ 档位: 上游值 | null }` 的字典。字典里没写的档位一律视为不支持，
 * 所以「支持哪些」必须一次讲全，漏写就等于关掉了那一档。给空字典会被宿主判成配置
 * 错误（`has an empty reasoningEfforts`），因此这里宁可返回 `undefined`，让登记时
 * 干脆不写这个字段。
 *
 * 上游元数据的 `reasoning` 有两种形状：
 *
 * - 富形状 `{ defaultEffort, supportedEfforts: [...], canDisableThinking }`：列全了档位。
 * - 简形状 `{ effort: 'high' }`：只说明「默认按这个档跑」，没有给可选集合，
 *   这种模型不给等级选择——编一份出来只会让用户选到上游不认的值。
 *
 * 档位名照抄上游的 `low` / `medium` / `high` / `xhigh` / `max`：请求发出去时用上游
 * 原值，与官方 CLI 完全一致。
 */

/** 宿主认识的档位，顺序即选择器里的展示顺序。 */
export const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 上游用来表示「可以彻底关掉思考」的标记名。 */
export const DISABLE_FLAG = 'canDisableThinking'

/**
 * 把上游的 `reasoning` 声明折成宿主要的字典。
 *
 * @param {unknown} reasoning 上游元数据里的 `reasoning` 字段。
 * @returns {Record<string, string> | undefined} 不支持的模型返回 `undefined`。
 */
export function reasoningEffortsOf(reasoning) {
  if (typeof reasoning !== 'object' || reasoning === null || Array.isArray(reasoning)) return undefined
  const supported = Array.isArray(reasoning.supportedEfforts) ? reasoning.supportedEfforts : []
  const efforts = {}
  let declared = 0
  for (const level of THINKING_LEVELS) {
    if (!supported.includes(level)) continue
    declared += 1
    const value = typeof reasoning.defaultEffort === 'string' && reasoning.defaultEffort === level
      ? reasoning.defaultEffort
      : level
    efforts[level] = value
  }
  // 只有 off 的模型等于没有推理：宿主要求至少有一档 beyond off，否则判配置非法。
  if (declared === 0) return undefined
  return efforts
}

/** 上游能不能把思考关掉；关不掉时选择器不该给「关闭」这一档。 */
export function canDisableThinking(reasoning) {
  return typeof reasoning === 'object' && reasoning !== null && reasoning[DISABLE_FLAG] === true
}

/**
 * 判断一份等级声明能不能交给宿主。
 *
 * 宿主对空字典会直接判配置非法（`has an empty reasoningEfforts`），`false` 与
 * 非空字典才合法。
 */
export function isReasoningEfforts(value) {
  if (value === false) return true
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0
}

/**
 * 老缓存里没有等级数据时，按模型 id 认一认它的推理档位，更新一次清单后就会以
 * 上游声明为准。
 *
 * 这里刻意只覆盖最难等的几个——老 `plugin.json` 里存的是没有等级的旧清单，
 * 用户升级插件后要等下一次刷新（最多一天）才看到等级，体验太差。
 *
 * 上游只给简形状（`{ effort }`，说明默认档、不列可选档）的模型，按默认档登记：
 * 选择器里只出现上游认的那一档，用户点不到没声明的值。
 */
export const KNOWN_EFFORTS = {
  'deepseek-v4.1-flash': ['low', 'high', 'max'],
  'deepseek-v4-pro': ['low', 'high', 'max'],
  'hy4-preview': ['high'],
  'hy3': ['high'],
  'step-5-preview': ['low', 'medium', 'high'],
  'space-bunny': ['low', 'medium', 'high', 'xhigh', 'max'],
  'minimax-m3.1-flash': ['low', 'medium', 'high', 'xhigh', 'max'],
  'minimax-m3': ['medium'],
  'glm-5.3': ['low', 'high', 'max'],
  'glm-5.3-flash': ['low', 'high', 'max'],
  'glm-5.2': ['medium'],
  'glm-5.1': ['medium'],
  'glm-5v-turbo': ['medium'],
  'kimi-k3-1': ['medium'],
  'kimi-k2.8-preview': ['low', 'high', 'max'],
  'kimi-k2.7': ['medium'],
  'kimi-k2.6': ['medium'],
  'mimo-v2.6-pro': ['high'],
  'auto': ['high'],
}

/**
 * 补一份模型清单里缺的等级声明。
 *
 * 已经是新格式（带 `reasoningEfforts`）的条目原样保留；没有登记过的模型不加，
 * 免得给一个不认识的后端凭空许诺档位。
 */
export function fillKnownEfforts(models) {
  return models.map(model => {
    if (model.reasoningEfforts !== undefined) return model
    const known = KNOWN_EFFORTS[model.id]
    if (known === undefined) return model
    return { ...model, reasoningEfforts: Object.fromEntries(known.map(level => [level, level])) }
  })
}

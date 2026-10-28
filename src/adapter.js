/**
 * 原生 provider 适配器：直接实现宿主的 `LlmAdapter` 契约，不再经过本地代理。
 *
 * 与旧实现的区别是根本性的。旧实现起一个回环 HTTP 端点，把它的地址写进宿主的
 * `llm-pi-ai` 设置当 provider，请求要绕一圈：宿主 → HTTP → 代理 → 上游 → 代理 →
 * 宿主。现在适配器自己拿到 `GenerateOptions`，自己拼请求体、自己读上游的 SSE、
 * 自己产出宿主的分片，中间没有任何端口、没有共享密钥、也不往宿主设置里写东西。
 *
 * 账号轮换与故障转移仍然在分发这一层完成：响应开始之前的失败换下一个账号，已经
 * 吐过正文之后再断的交给宿主按重试策略重发（那时欠费账号已进冷却，重发自然落到
 * 下一个账号）。
 */
import { ensureFresh } from './auth.js'
import { prepareChatBody } from './chat-request.js'
import { chatBaseOf, chatHeaders, chatPaths, isPathMiss } from './protocol.js'
import { FAILOVER_KINDS, classifyChatFailure, classifyStreamFailure, isCreditExhaustion } from './chat-upstream.js'
import { finishReasonOf, mapUsage, readChatStream, repairToolPairing, toChatMessages, toToolDefs } from './wire.js'

/** 宿主认识的失败码。写错一个，宿主就认不出这是可重试还是终态。 */
export const CODE = {
  quota: 'QUOTA',
  accountQuota: 'ACCOUNT_QUOTA',
  credential: 'INVALID_CREDENTIAL',
  rateLimit: 'RATE_LIMIT',
  server: 'SERVER',
  transport: 'TRANSPORT',
  timeout: 'TIMEOUT',
  client: 'CLIENT_ERROR',
  empty: 'EMPTY_RESPONSE',
  aborted: 'ABORTED',
}

/** 上游失败类别 → 宿主失败码。 */
const CODE_FOR_KIND = {
  hard_credit: CODE.accountQuota,
  soft_rate: CODE.rateLimit,
  session_dead: CODE.credential,
  not_found: CODE.server,
  server: CODE.server,
  client: CODE.client,
  aborted: CODE.aborted,
}

/** 上游不认这个推理档位时返回的业务码（HTTP 400）。 */
const EFFORT_REJECTED_CODE = '11150'

function isEffortRejection(message) {
  const text = String(message ?? '')
  return text.includes(EFFORT_REJECTED_CODE) || /reasoning effort value is not supported/i.test(text)
}

/**
 * 依次尝试的请求体：原样 → 去掉推理档位 → 去掉整个推理字段。
 *
 * 档位的可用集合由模型决定，且随上游发版变化，本地硬编码白名单只会过期。这里
 * 不做预判，只在被拒时退一步重发，代价是一次多花几毫秒的空请求。
 */
function effortFallbacks(body) {
  const variants = [body]
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return variants
  const withoutEffort = { ...body }
  delete withoutEffort.reasoning_effort
  if (Object.keys(withoutEffort).length !== Object.keys(body).length) variants.push(withoutEffort)
  const withoutReasoning = { ...withoutEffort }
  delete withoutReasoning.reasoning
  if (Object.keys(withoutReasoning).length !== Object.keys(withoutEffort).length) variants.push(withoutReasoning)
  return variants
}

/**
 * 把宿主的 `GenerateOptions` 拼成上游的请求体。
 *
 * 这里只负责「宿主词汇 → 上游词汇」；把 `developer` 角色改回 `system`、把
 * `max_completion_tokens` 翻成 `max_tokens`、绕开渠道指纹这些上游专属的整形，
 * 统一交给 {@link prepareChatBody}，与旧代理走的是同一套规则，行为不会漂移。
 */
export function buildChatBody(options, modelId) {
  const body = {
    model: modelId,
    messages: toChatMessages(repairToolPairing(options.messages)),
    stream: true,
    stream_options: { include_usage: true },
  }
  const tools = toToolDefs(options.tools)
  if (tools.length > 0) body.tools = tools
  if (typeof options.temperature === 'number' && Number.isFinite(options.temperature)) body.temperature = options.temperature
  if (Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0) body.max_tokens = options.maxTokens
  if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop
  if (typeof options.reasoningEffort === 'string' && options.reasoningEffort !== '') {
    body.reasoning_effort = options.reasoningEffort
  }
  return body
}

/** 一次上游调用：返回响应或一个可判定的失败。 */
async function postChat(credential, body, signal) {
  const base = chatBaseOf(credential.region)
  let last = { ok: false, kind: 'server', message: '没有可用的聊天端点' }
  for (const path of chatPaths(credential.region)) {
    let response
    try {
      response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: chatHeaders(credential),
        body,
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      // 调用方取消不是账号问题，必须原样上抛，不能换账号重试。
      if (signal?.aborted === true) return { ok: false, kind: 'aborted', message: '请求已取消' }
      last = { ok: false, kind: 'server', message: error instanceof Error ? error.message : String(error) }
      continue
    }
    if (response.ok) return { ok: true, response }
    const text = await response.text().catch(() => '')
    last = { ok: false, ...classifyChatFailure(response.status, text) }
    // 只有路由落空才换路径；业务拒绝必须原样返回，换路径只会重复被拒。
    if (!isPathMiss(response.status)) return last
  }
  return last
}

/**
 * 适配器。
 *
 * 依赖全部由插件在装配时注入，适配器自己不读磁盘、不读环境变量——它只回答
 * 「现在有哪些模型」「这个模型怎么调」「这一轮用哪个账号」。
 */
export class CreditsPoolAdapter {
  /**
   * @param {{
   *   accountsOf: () => object[],
   *   rotator: object,
   *   modelsOf: () => Array<object>,
   *   prepareAccount?: (account: object) => Promise<object>,
   *   onUsage?: (entry: object) => void,
   *   onFailure?: (info: object) => void,
   *   providerId: string,
   *   displayName: string,
   *   defaultContextWindow: number,
   *   defaultMaxTokens: number,
   *   logger?: object,
   * }} deps
   */
  constructor(deps) {
    this.deps = deps
    this.providerId = deps.providerId
    this.displayName = deps.displayName
  }

  /** 路由的显示名。宿主拿它当模型选择器里的分组标题。 */
  providerInfo(provider) {
    return { id: provider, name: this.displayName }
  }

  /**
   * 重试策略。
   *
   * 把欠费类错误码补进可重试列表：宿主默认只重试 `EMPTY_RESPONSE` / `RATE_LIMIT` /
   * `SERVER` / `TIMEOUT` / `TRANSPORT`，欠费落成 `QUOTA` / `ACCOUNT_QUOTA` 时直接判
   * 终态，任务就停在半路。补进来之后，重试会重新进适配器，而适配器已把欠费账号
   * 打进冷却，于是自然换到下一个账号——上下文由宿主带着原样重发，不丢。
   */
  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 3,
      retryableCodes: Object.freeze([
        'EMPTY_RESPONSE',
        'RATE_LIMIT',
        'SERVER',
        'TIMEOUT',
        'TRANSPORT',
        'QUOTA',
        'ACCOUNT_QUOTA',
      ]),
      initialDelayMs: 500,
      maxDelayMs: 8000,
      jitterRatio: 0.2,
    })
  }

  /** 本插件登记的都是纯文本路由，没有按图计价的协议。 */
  imageRequestPricing() {
    return undefined
  }

  /** 当前该出现在模型选择器里的模型。 */
  async listModels(provider) {
    return (this.deps.modelsOf() ?? []).map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      ...(typeof model.description === 'string' && model.description !== '' ? { description: model.description } : {}),
      inputModalities: ['text'],
    }))
  }

  /**
   * 解析一个精确模型的能力。
   *
   * 宿主会逐字段校验这里返回的东西，任何一项不合法都会让整次调用以
   * `INVALID_MODEL_*` 失败，所以缺省值必须在这里补齐，而不是留给下游猜。
   */
  async resolveModel(provider, model) {
    const entry = (this.deps.modelsOf() ?? []).find(candidate => candidate.id === model)
    const contextWindow = Number.isInteger(entry?.contextWindow) && entry.contextWindow > 0
      ? entry.contextWindow
      : this.deps.defaultContextWindow
    const maxTokens = Number.isInteger(entry?.maxTokens) && entry.maxTokens > 0
      ? entry.maxTokens
      : this.deps.defaultMaxTokens
    const resolved = {
      provider,
      id: model,
      name: entry?.name ?? model,
      inputModalities: ['text'],
      context: { contextWindow },
      defaultMaxTokens: maxTokens,
    }
    const efforts = effortsOf(entry)
    if (efforts !== undefined) resolved.reasoning = efforts
    return resolved
  }

  /**
   * 把模型元数据与分发闭包绑在同一份状态快照上。
   *
   * 这样清单在回合中途刷新时，不会出现「一个代次的能力配另一个代次的端点」。
   */
  async prepareCall(provider, model) {
    const models = this.deps.modelsOf() ?? []
    const entry = models.find(candidate => candidate.id === model) ?? null
    return {
      model: await this.resolveModel(provider, model),
      stream: options => this.stream(options, entry),
    }
  }

  /**
   * 一次模型调用。
   *
   * 账号按轮换策略排好序，逐个尝试。换账号只发生在响应开始之前：流已经开始之后
   * 才断的，把两段回答拼起来比报错更糟，所以那时如实结束这一轮，让宿主按重试
   * 策略重发。
   */
  stream(options, entry) {
    const controller = new AbortController()
    const onAbort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted === true) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
    const iterator = this.runStream({ ...options, signal: controller.signal }, entry)
    const cleanup = () => options.signal?.removeEventListener('abort', onAbort)
    const step = async (method, value) => {
      try {
        const row = await iterator[method](value)
        if (row.done) cleanup()
        return row
      } catch (error) {
        cleanup()
        throw error
      }
    }
    return {
      [Symbol.asyncIterator]() { return this },
      next: value => step('next', value),
      return: value => { controller.abort(); cleanup(); return step('return', value) },
      throw: error => { controller.abort(error); cleanup(); return step('throw', error) },
    }
  }

  async * runStream(options, entry) {
    const modelId = options.model
    const accounts = this.deps.accountsOf() ?? []
    if (accounts.length === 0) {
      yield failureChunk('账号库里没有可用账号，先运行 login 或 import', CODE.credential)
      return
    }
    if (entry === null) {
      yield failureChunk(`本插件不提供模型「${modelId}」`, CODE.client)
      return
    }

    const conversationId = conversationKeyOf(options)
    const body = buildChatBody(options, modelId)
    const prepared = prepareChatBody(JSON.stringify(body))
    const prepareAccount = this.deps.prepareAccount ?? (async account => account)
    let last = { kind: 'server', message: '没有可用账号' }
    const tried = []

    for (const account of this.deps.rotator.order(accounts, { conversationId })) {
      if (options.signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '请求已取消', code: CODE.aborted } } }
        return
      }
      tried.push(account.id)
      let credential
      try {
        credential = await prepareAccount(account)
      } catch (error) {
        // 令牌刷新失败不是这次请求的错：记为登录态失效进冷却，继续下一个账号。
        last = { kind: 'session_dead', message: error instanceof Error ? error.message : String(error) }
        this.deps.rotator.noteFailure(account.id, 'session_dead')
        this.noteUsage({ accountId: account.id, model: modelId, conversationId, ok: false, kind: 'session_dead' })
        continue
      }

      let result = await postChat(credential, prepared, options.signal)
      if (!result.ok && isEffortRejection(result.message)) {
        for (const variant of effortFallbacks(body).slice(1)) {
          result = await postChat(credential, prepareChatBody(JSON.stringify(variant)), options.signal)
          if (!isEffortRejection(result.message)) break
        }
      }

      if (result.ok) {
        this.deps.rotator.noteSuccess(account.id)
        yield * this.pump(result.response, {
          accountId: account.id,
          model: modelId,
          conversationId,
          signal: options.signal,
          contextWindow: entry.contextWindow,
        })
        return
      }

      last = result
      if (result.kind === 'aborted') {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '请求已取消', code: CODE.aborted } } }
        return
      }
      this.noteUsage({ accountId: account.id, model: modelId, conversationId, ok: false, kind: result.kind })
      // 上游判「非法调用」时，拒绝理由只在请求体里：形状与整份请求体交给调用方，
      // 事后能拿真身去复现，不用靠猜。正文不进日志。
      if (result.kind === 'client') {
        try {
          this.deps.onFailure?.({ shape: messageShapeOf(body), body: prepared, message: result.message ?? '' })
        } catch (error) {
          this.deps.logger?.warn?.(`[multi-credits-pool] 记录被拒请求失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (FAILOVER_KINDS.has(result.kind)) {
        this.deps.rotator.noteFailure(account.id, result.kind)
        this.deps.logger?.warn?.(`[multi-credits-pool] 账号 ${account.id} 失败（${result.kind}），换下一个`)
        continue
      }
      break
    }

    const code = CODE_FOR_KIND[last.kind] ?? CODE.server
    const suffix = tried.length > 0 ? `（已尝试 ${tried.join(', ')}）` : ''
    yield failureChunk(`${last.message ?? '上游拒绝'}${suffix}`, code)
  }

  /**
   * 读一次成功的响应，把分片喂给宿主。
   *
   * 用量与失败在这里结算：流跑完才落一条流水，顺带把末尾的 usage 带上；流里报错
   * （含额度耗尽）算这个账号失败，让下一次请求绕开它。
   */
  async * pump(response, context) {
    const stream = readChatStream(response.body, { signal: context.signal })
    let outcome
    try {
      while (true) {
        const row = await stream.next()
        if (row.done === true) {
          outcome = row.value
          break
        }
        yield row.value
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const streamFailure = error?.streamError === true ? classifyStreamFailure(message) : undefined
      if (streamFailure !== undefined) {
        this.deps.rotator.noteFailure(context.accountId, streamFailure.kind)
        this.deps.logger?.warn?.(`[multi-credits-pool] 账号 ${context.accountId} 的响应流里报错（${streamFailure.kind}）：${message}`)
      }
      this.noteUsage({
        accountId: context.accountId,
        model: context.model,
        conversationId: context.conversationId,
        ok: false,
        kind: streamFailure?.kind ?? 'server',
      })
      const code = streamFailure === undefined
        ? (context.signal?.aborted === true ? CODE.aborted : CODE.transport)
        : (CODE_FOR_KIND[streamFailure.kind] ?? CODE.server)
      yield {
        type: 'finish',
        reason: context.signal?.aborted === true
          ? { kind: 'aborted', failure: { message, code: CODE.aborted } }
          : { kind: 'error', failure: { message, code } },
      }
      return
    }

    const usage = outcome.usage
    if (usage !== undefined) yield { type: 'usage', usage }
    this.noteUsage({
      accountId: context.accountId,
      model: context.model,
      conversationId: context.conversationId,
      ok: true,
      promptTokens: usage?.inputTokens,
      completionTokens: usage?.outputTokens,
    })

    // 参数解析不出来的工具调用：降级成 max-tokens，让宿主的组装器把它剪掉，
    // 而不是执行一个半截调用然后看模型反复重试。
    if (outcome.brokenToolCall === true) {
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
      return
    }
    if (outcome.sawText !== true && outcome.sawToolCall !== true && outcome.sawReasoning !== true) {
      yield failureChunk('上游返回了空响应', CODE.empty)
      return
    }
    yield { type: 'finish', reason: finishReasonOf(outcome.finish) }
  }

  /** 记一条使用流水。统计失败不能影响对话本身。 */
  noteUsage(entry) {
    const sink = this.deps.onUsage
    if (typeof sink !== 'function') return
    try {
      sink(entry)
    } catch (error) {
      this.deps.logger?.warn?.(`[multi-credits-pool] 使用流水记录失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}


/**
 * 把请求体里的消息形状写成一行，用于失败时留证据。
 *
 * 只记角色与内容块的类型，不记正文：上游的拒绝理由有时只在形状上，比如自称落在
 * 第二个内容块里，日志里看不出正文有多长，却能看出这是多块 system。
 */
function messageShapeOf(body) {
  const messages = body?.messages
  if (!Array.isArray(messages)) return 'no-messages'
  return messages.map(message => {
    const role = typeof message?.role === 'string' ? message.role : 'unknown'
    const content = message?.content
    if (typeof content === 'string') return `${role}:string`
    if (!Array.isArray(content)) return `${role}:${typeof content}`
    const parts = content.map(part => (typeof part === 'string' ? 'string' : typeof part?.type === 'string' ? part.type : typeof part))
    return `${role}:[${parts.join(',')}]`
  }).join(' ')
}

/** 一个终止的失败分片。 */
function failureChunk(message, code) {
  return { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
}

/**
 * 这段对话的标识。
 *
 * 宿主把会话 id 放在 `options.sessionId` 里。前缀必须与设置看板算出来的那个
 * 一致（`client.js` 的 `CONVERSATION_KEY_PREFIX`）：看板写入的固定表、适配器
 * 查的键、以及「这段对话现在走哪个账号」的显示，三处得是同一个字符串，否则
 * 用户在看板上固定的账号对请求不起作用。
 *
 * 拿不到时返回 undefined，轮换策略退回按 LRU 走——不会把「不知道是哪段对话」
 * 当成「同一段对话」。
 */
const CONVERSATION_KEY_PREFIX = 'prompt_cache_key:'

function conversationKeyOf(options) {
  const id = options?.sessionId
  return typeof id === 'string' && id !== '' ? `${CONVERSATION_KEY_PREFIX}${id}` : undefined
}

/**
 * 把模型清单里的推理档位声明折成宿主认的 `reasoning` 元数据。
 *
 * 宿主只认 `{ efforts: [{id, name}], defaultEffort? }`，且 `efforts` 不能为空、
 * `id` 不能重复。清单里存的是 `{档位: 上游值}` 的字典（见 reasoning.js），这里
 * 转成数组；空字典或没有声明时返回 undefined，让宿主干脆不给这一档下拉。
 */
function effortsOf(entry) {
  const declared = entry?.reasoningEfforts
  if (declared === undefined || declared === false) return undefined
  if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) return undefined
  const efforts = []
  for (const [id, value] of Object.entries(declared)) {
    if (typeof id !== 'string' || id === '') continue
    efforts.push({ id, name: labelOf(id), description: `上游档位 ${typeof value === 'string' ? value : id}` })
  }
  if (efforts.length === 0) return undefined
  const preferred = typeof entry?.defaultEffort === 'string' && efforts.some(effort => effort.id === entry.defaultEffort)
    ? entry.defaultEffort
    : undefined
  return preferred === undefined ? { efforts } : { efforts, defaultEffort: preferred }
}

const EFFORT_LABELS = {
  minimal: '最少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最大',
}

function labelOf(id) {
  return EFFORT_LABELS[id] ?? id
}

export { isCreditExhaustion, mapUsage }

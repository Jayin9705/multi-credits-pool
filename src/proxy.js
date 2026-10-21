/**
 * 本地 OpenAI 兼容代理。
 *
 * DSH 的 provider 指向这个回环端点；账号选择、令牌刷新与故障转移全部在转发这一层
 * 完成，上层的模型调用不需要知道有几个账号。
 *
 * 只绑 127.0.0.1，并要求共享密钥：回环网卡不是信任边界，同机的其它进程也能访问。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { Readable, Transform } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { FAILOVER_KINDS, classifyStreamFailure } from './chat-upstream.js'

/** 上游失败类别 → 对上层暴露的 HTTP 状态。 */
const KIND_STATUS = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  not_found: 502,
  server: 502,
  client: 400,
  aborted: 499,
}

const BODY_LIMIT = 64 * 1024 * 1024

/** 上游不认这个推理档位时返回的业务码（HTTP 400）。 */
const EFFORT_REJECTED_CODE = '11150'

function isEffortRejection(result) {
  const message = String(result?.message ?? '')
  return message.includes(EFFORT_REJECTED_CODE) || /reasoning effort value is not supported/i.test(message)
}

/**
 * 生成依次尝试的请求体：原样 → 去掉推理档位 → 去掉整个推理字段。
 *
 * 档位的可用集合由模型决定，而且随上游发版变化，本地硬编码一份白名单只会过期；
 * 这里不做预判，只在被拒时退一步重发，代价是一次多花几毫秒的空请求。
 */
function effortFallbacks(bodyText) {
  const variants = [bodyText]
  let body
  try {
    body = JSON.parse(bodyText)
  } catch {
    return variants
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return variants

  const withoutEffort = { ...body }
  delete withoutEffort.reasoning_effort
  if (Object.keys(withoutEffort).length !== Object.keys(body).length) variants.push(JSON.stringify(withoutEffort))

  const withoutReasoning = { ...withoutEffort }
  delete withoutReasoning.reasoning
  if (Object.keys(withoutReasoning).length !== Object.keys(withoutEffort).length) variants.push(JSON.stringify(withoutReasoning))
  return variants
}

/**
 * 把请求体里的消息形状写成一行，用于失败时留证据。
 *
 * 只记角色与内容块的类型，不记正文：上游的拒绝理由有时只在形状上，比如自称落在
 * 第二个内容块里，日志里看不出正文有多长，却能看出这是多块 system。
 */
function messageShapeOf(bodyText) {
  let body
  try {
    body = JSON.parse(bodyText.replace(/^\uFEFF/, ''))
  } catch {
    return 'unparsed'
  }
  const messages = body?.messages
  if (!Array.isArray(messages)) return 'no-messages'
  return messages.map(shapeOfMessage).join(' ')
}

function shapeOfMessage(message) {
  const role = typeof message?.role === 'string' ? message.role : 'unknown'
  const content = message?.content
  if (typeof content === 'string') return `${role}:string`
  if (!Array.isArray(content)) return `${role}:${typeof content}`
  const parts = content.map(part => (typeof part === 'string' ? 'string' : typeof part?.type === 'string' ? part.type : typeof part))
  return `${role}:[${parts.join(',')}]`
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeError(res, status, kind, message) {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
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

/** 回环 Host 校验：挡住 DNS 重绑定与跨源页面。 */
function hostIsLoopback(host) {
  if (typeof host !== 'string') return false
  const name = host.split(':')[0] ?? ''
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

/**
 * 顺手从响应流里捞用量与流内错误。
 *
 * 上游把 `usage` 放在流末尾那片 chunk 里（`prompt_tokens` / `completion_tokens`），
 * 而这时响应头早就发出去了，没法回头改。所以这里只做旁路观察：把流原样往下游
 * 透传，同时扫一遍完整的 SSE 行，流结束时把捞到的数字交出去。
 *
 * 也顺手认一下流里的 `error` 事件：上游偶尔先回 200，再把额度耗尽之类的拒绝放进
 * 流里。那种情况下 HTTP 状态码是 200，只有正文能说明问题。
 *
 * 只保留一个未闭合行的缓冲，不缓存整个响应；非流式响应另留一小段原文用于兜底解析。
 */
function createUsageTap(onDone) {
  const decoder = new StringDecoder('utf8')
  const PLAIN_LIMIT = 256 * 1024
  let buffer = ''
  let plain = ''
  let sseSeen = false
  let promptTokens
  let completionTokens
  let streamModel
  let streamErrorText
  let done = false
  // 流没跑完就断了时记下原因：这次请求用户没拿到完整回答，记成失败更贴近事实。
  let failureKind

  function collect(line) {
    const text = line.trim()
    if (!text.startsWith('data:')) return
    sseSeen = true
    const payload = text.slice(5).trim()
    if (payload === '' || payload === '[DONE]') return
    let parsed
    try {
      parsed = JSON.parse(payload)
    } catch {
      return
    }
    if (parsed === null || typeof parsed !== 'object') return
    if (streamModel === undefined && typeof parsed.model === 'string' && parsed.model !== '') streamModel = parsed.model
    // 流内报错：上游先回 200，再把拒绝放进流里。这里只记下正文与原始 JSON，
    // 归类交给调用方（它才知道该用哪套 kind）。
    if (streamErrorText === undefined && parsed.error !== undefined && parsed.error !== null) {
      streamErrorText = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error)
      return
    }
    const usage = parsed.usage
    if (usage === null || typeof usage !== 'object') return
    if (Number.isFinite(usage.prompt_tokens)) promptTokens = usage.prompt_tokens
    if (Number.isFinite(usage.completion_tokens)) completionTokens = usage.completion_tokens
  }

  function scan(text) {
    buffer += text
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) collect(line)
  }

  function finish() {
    if (done) return
    done = true
    scan(decoder.end())
    if (buffer !== '') collect(buffer)
    buffer = ''
    // 非流式响应：整段就是一个 JSON 对象，按 SSE 行扫不到 usage。
    if (!sseSeen && plain !== '') {
      try {
        const parsed = JSON.parse(plain)
        const usage = parsed?.usage
        if (usage !== null && typeof usage === 'object') {
          if (Number.isFinite(usage.prompt_tokens)) promptTokens = usage.prompt_tokens
          if (Number.isFinite(usage.completion_tokens)) completionTokens = usage.completion_tokens
        }
        if (streamModel === undefined && typeof parsed?.model === 'string' && parsed.model !== '') streamModel = parsed.model
      } catch {
        // 不是完整 JSON 就算了，用量留空。
      }
    }
    plain = ''
    onDone({ promptTokens, completionTokens, model: streamModel, failureKind, errorText: streamErrorText })
  }

  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      const text = decoder.write(chunk)
      if (plain.length < PLAIN_LIMIT) plain += text
      scan(text)
      callback(null, chunk)
    },
    flush(callback) {
      finish()
      callback()
    },
    destroy(_error, callback) {
      // 下游断开或上游掐断都会走到这里。是否算失败由调用方判定，这里只负责
      // 把已经花掉的用量结算掉，并且绝不让 error 冒到进程上。
      if (!done) finish()
      callback(null)
    },
  })
  /** 正常结束并结算用量。 */
  tap.finish = () => finish()
  /** 标记这次请求失败后再结算。 */
  tap.noteFailure = kind => {
    if (failureKind === undefined) failureKind = kind
    finish()
  }
  /** 丢弃这次请求，不记流水（发头之前就断了，调用方会另记一条失败）。 */
  tap.abandon = () => {
    done = true
  }
  return tap
}

/**
 * @param {{
 *   accountsOf: () => object[],
 *   upstream: {streamChat: Function},
 *   rotator: {order: Function, noteSuccess: Function, noteFailure: Function},
 *   modelsOf: () => Array<{id: string}>,
 *   prepareAccount?: (account: object) => Promise<object>,
 *   onUsage?: (entry: object) => void,
 *   onRejected?: (info: {shape: string, body: string, message: string}) => void,
 *   port?: number,
 *   secret?: string,
 *   logger?: {warn: Function, error: Function},
 * }} options
 */
export function createChatProxy(options) {
  const { accountsOf, upstream, rotator, modelsOf } = options
  const prepareAccount = options.prepareAccount ?? (async account => account)
  const onUsage = typeof options.onUsage === 'function' ? options.onUsage : undefined
  const onRejected = typeof options.onRejected === 'function' ? options.onRejected : undefined
  const logger = options.logger
  const port = Number.isInteger(options.port) ? options.port : 0
  const secret = typeof options.secret === 'string' && options.secret !== ''
    ? options.secret
    : randomBytes(32).toString('base64url')

  function bearerOk(req) {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const presented = Buffer.from(match[1])
    const expected = Buffer.from(secret)
    return presented.length === expected.length && timingSafeEqual(presented, expected)
  }

  /**
   * 这段对话的标识。
   *
   * 主通道是请求体里的 `prompt_cache_key`：插件注册的 provider 设了
   * `cacheRetention: 'long'`，宿主会把会话 id 写进这个字段（还会带上
   * `prompt_cache_retention: '24h'`）。会话亲和头（`x-client-request-id` 等）
   * 在宿主的 `COMPLETIONS_COMPAT_GATE` 里是 withhold，本路由实际收不到，
   * 这里仍然认它们，是为了兼容直连本代理的其它 OpenAI 客户端。
   *
   * 全部拿不到时返回 undefined，策略退回按 LRU 走。
   */
  function conversationIdOf(req, raw) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.prompt_cache_key === 'string' && parsed.prompt_cache_key !== '') {
        return `prompt_cache_key:${parsed.prompt_cache_key}`
      }
    } catch {
      // 请求体不是 JSON 时上游自己会报错，这里不越权处理。
    }
    for (const name of ['x-client-request-id', 'x-session-affinity', 'session_id', 'x-session-id']) {
      const value = req.headers[name]
      if (typeof value === 'string' && value !== '') return `${name}:${value}`
    }
    return undefined
  }

  /** 请求体里的模型名；解析不出来返回 undefined，由调用方记成 unknown。 */
  function modelOf(raw) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.model === 'string') return parsed.model
    } catch {
      // 请求体不是 JSON 时上游自己会报错，这里不越权处理。
    }
    return undefined
  }

  /** 记一条使用流水。统计失败不能影响对话本身，所以整体兜住异常。 */
  function noteUsage(entry) {
    if (onUsage === undefined) return
    try {
      onUsage(entry)
    } catch (error) {
      logger?.warn?.(`使用流水记录失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function chatCompletions(req, res) {
    const raw = await readBody(req)
    const accounts = accountsOf()
    if (accounts.length === 0) {
      writeError(res, 401, 'not_signed_in', '账号库里没有可用账号，先运行 login 或 import')
      return
    }

    const controller = new AbortController()
    req.on('close', () => controller.abort())

    const conversationId = conversationIdOf(req, raw)
    const model = modelOf(raw)
    let last = { kind: 'server', status: 0, message: '没有可用账号' }
    const tried = []
    for (const account of rotator.order(accounts, { conversationId })) {
      tried.push(account.id)
      let credential
      try {
        credential = await prepareAccount(account)
      } catch (error) {
        // 令牌刷新失败不是这次请求的错，记为登录态失效进入冷却，继续下一个账号。
        last = { kind: 'session_dead', status: 401, message: error instanceof Error ? error.message : String(error) }
        rotator.noteFailure(account.id, 'session_dead')
        noteUsage({ accountId: account.id, model, conversationId, ok: false, kind: 'session_dead' })
        continue
      }

      let result = await upstream.streamChat(credential, raw, controller.signal)
      if (!result.ok && isEffortRejection(result)) {
        for (const variant of effortFallbacks(raw).slice(1)) {
          result = await upstream.streamChat(credential, variant, controller.signal)
          if (!isEffortRejection(result)) break
        }
        if (result.ok) logger?.warn?.(`账号 ${account.id} 不接受该推理档位，已去掉档位重发`)
      }
      if (result.ok) {
        rotator.noteSuccess(account.id)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'X-Credits-Account': account.id,
        })
        // 一次请求只记一条：等流跑完（或下游断开）再落，顺带把末尾的用量带上。
        const tap = createUsageTap(({ promptTokens, completionTokens, model: streamModel, failureKind, errorText }) => {
          // 流里报了错（含额度耗尽）：算这次账号失败，让下一次请求绕开它。
          const streamFailure = errorText === undefined ? undefined : classifyStreamFailure(errorText)
          const kind = failureKind ?? streamFailure?.kind
          if (streamFailure !== undefined) {
            rotator.noteFailure(account.id, streamFailure.kind)
            logger?.warn?.(`账号 ${account.id} 的响应流里报错（${streamFailure.kind}）：${streamFailure.message}`)
          }
          noteUsage({
            accountId: account.id,
            model: model ?? streamModel,
            conversationId,
            ok: kind === undefined,
            ...(kind === undefined ? {} : { kind }),
            promptTokens,
            completionTokens,
          })
        })
        const source = Readable.fromWeb(result.response.body)
        // 响应头已经发出去了，这时候换账号重试只会把两段回答拼在一起，比报错更糟。
        // 能做的是把下游收尾干净，并在流水里如实记一笔失败。
        source.on('error', error => {
          logger?.warn?.(`账号 ${account.id} 的响应流中途断开：${error instanceof Error ? error.message : String(error)}`)
          tap.noteFailure('server')
          if (!res.writableEnded) res.end()
        })
        res.on('error', () => {
          // 下游已经断了，没什么可写的；顺手把旁路收掉，免得它挂在半空里。
          tap.destroy()
        })
        source.pipe(tap).pipe(res)
        return
      }
      last = result
      if (result.kind === 'aborted') {
        if (!res.headersSent) writeError(res, 499, 'aborted', '请求已取消')
        return
      }
      noteUsage({ accountId: account.id, model, conversationId, ok: false, kind: result.kind })
      if (FAILOVER_KINDS.has(result.kind)) {
        rotator.noteFailure(account.id, result.kind)
        logger?.warn?.(`账号 ${account.id} 失败（${result.kind}），尝试下一个`)
        continue
      }
      break
    }

    if (!res.headersSent) {
      // 被上游判成非法调用时留证据：这类拒绝的理由只在请求体里，正文不进日志，
      // 但形状与整份请求体交给调用方，方便下次形状又变时看出差在哪。
      if (last.kind === 'client') {
        const shape = messageShapeOf(raw)
        logger?.warn?.(`上游判请求非法（${last.message ?? ''}），消息形状：${shape}`)
        try {
          onRejected?.({ shape, body: raw, message: last.message ?? '' })
        } catch (error) {
          logger?.warn?.(`记录被拒请求失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      writeError(res, KIND_STATUS[last.kind] ?? 502, last.kind, `${last.message ?? '上游拒绝'}（已尝试 ${tried.join(', ') || '无'}）`)
    }
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (!hostIsLoopback(req.headers.host)) return writeError(res, 403, 'host_not_allowed', 'Host 必须是回环地址')
        if (!bearerOk(req)) return writeError(res, 401, 'unauthorized', '缺少或错误的 Bearer')
        const url = (req.url ?? '/').replace(/\/+$/, '')
        if (req.method === 'GET' && url === '/v1/models') {
          return writeJson(res, 200, {
            object: 'list',
            data: modelsOf().map(model => ({ id: model.id, object: 'model', created: 0, owned_by: 'multi-credits-pool' })),
          })
        }
        if (req.method === 'POST' && url === '/v1/chat/completions') return await chatCompletions(req, res)
        return writeError(res, 404, 'not_found', `没有这个路由：${req.method} ${url}`)
      } catch (error) {
        logger?.error?.('代理请求失败', error)
        if (!res.headersSent) writeError(res, 500, 'internal', error instanceof Error ? error.message : String(error))
        else res.end()
      }
    })()
  })

  const ready = new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  server.listen(port, '127.0.0.1')

  return {
    ready,
    baseUrl() {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('代理还没有监听地址')
      return `http://127.0.0.1:${address.port}`
    },
    token: () => secret,
    close: () => new Promise((resolve, reject) => {
      server.close(() => resolve())
      server.closeAllConnections()
      server.once('error', reject)
    }),
  }
}

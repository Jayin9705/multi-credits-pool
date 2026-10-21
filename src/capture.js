/**
 * 请求落盘（排查用，默认关闭，头部常量打开后开始记录）。
 *
 * 写入数据目录的 `capture.jsonl`：每条请求一行概要（状态、消息条数、角色序列、工具数、
 * 请求体字段名），状态码 >= 400 时再多记一条完整请求体与脱敏后的请求头、上游正文。
 * 概要是为了把失败请求和前后成功的请求摆在一起对比，完整请求体是为了逐字核对字段。
 * 文件超过上限后停止追加；任何写盘异常都吞掉——排查工具不能反过来影响请求。
 *
 * 只在排查时临时打开：文件里存着用户对话原文，问题确认解决后要关掉并删除落盘文件。
 */
import { appendFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './paths.js'

/** 总开关：排查时改成 true，排查结束改回 false。 */
const ENABLED = false
/** 单个文件上限，够存几十条完整请求。 */
const FILE_LIMIT = 32 * 1024 * 1024
/** 请求体截断长度：长会话一条就二十万字符，留足余量保证整条存下。 */
const BODY_LIMIT = 1_200_000
const RESPONSE_LIMIT = 4000

const SECRET_HEADERS = new Set(['authorization', 'x-refresh-token', 'cookie', 'set-cookie'])

function captureFile() {
  return join(dataDir(), 'capture.jsonl')
}

function append(record) {
  try {
    if (!ENABLED) return
    const file = captureFile()
    if (existsSync(file) && statSync(file).size > FILE_LIMIT) return
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // 排查工具，写不进去就放弃。
  }
}

function summarize(bodyText) {
  try {
    const parsed = JSON.parse(bodyText)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { parse: 'non-object' }
    }
    const messages = Array.isArray(parsed.messages) ? parsed.messages : []
    return {
      keys: Object.keys(parsed).sort(),
      model: parsed.model,
      stream: parsed.stream,
      messages: messages.length,
      roles: messages.map(message => message?.role ?? '?'),
      tools: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
      bytes: bodyText.length,
    }
  } catch {
    return { parse: 'invalid-json', bytes: bodyText.length }
  }
}

function sanitizeHeaders(headers) {
  if (headers === undefined) return undefined
  const out = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SECRET_HEADERS.has(key.toLowerCase()) ? '<redacted>' : value
  }
  return out
}

/**
 * @param {{path: string, status: number, body: string, headers?: object, response?: string}} entry
 */
export function captureRequest(entry) {
  const record = {
    at: new Date().toISOString(),
    path: entry.path,
    status: entry.status,
    ...summarize(String(entry.body ?? '')),
  }
  append(record)
  if (entry.status < 400) return
  append({
    ...record,
    detail: 'body',
    headers: sanitizeHeaders(entry.headers),
    body: String(entry.body ?? '').slice(0, BODY_LIMIT),
    response: String(entry.response ?? '').slice(0, RESPONSE_LIMIT),
  })
}

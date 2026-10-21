/**
 * 上游聊天客户端。
 *
 * 只做一件事：按给定账号把请求发到上游，并把失败归成可判定的类别，让上层决定
 * 是否换账号重试。不做任何响应体转换——成功时把 SSE 原样交回调用方透传。
 */
import { captureRequest } from './capture.js'
import { prepareChatBody } from './chat-request.js'
import { chatBaseOf, chatHeaders, chatPaths, isPathMiss } from './protocol.js'

/** 换账号重试有意义的失败类别。 */
export const FAILOVER_KINDS = new Set(['hard_credit', 'soft_rate', 'session_dead'])

/**
 * 正文是不是「额度用完」这类说法。
 *
 * 上游把额度耗尽放在三种位置：HTTP 402、HTTP 429 的正文、以及 200 的 SSE 流里
 * 一片 `error` 事件。三处的措辞不完全一样，所以这里把已知的说法收成一个判断，
 * 让状态码与流内错误共用同一套标准。
 */
export function isCreditExhaustion(text) {
  const value = String(text ?? '')
  return value.includes('14018')
    || /credits?\s*exhausted/i.test(value)
    || value.includes('额度已用完')
    || /insufficient[\s_-]+(?:quota|balance|credits?)/i.test(value)
    || /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(value)
    || /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(value)
}

/**
 * 按 HTTP 状态与正文归类。
 *
 * 额度耗尽可能以 429 到达（正文带 14018 / Credits exhausted），此时它是账号级
 * 拒绝而非限流，换账号才有意义，所以归到 hard_credit。
 */
export function classifyChatFailure(status, bodyText) {
  const text = String(bodyText ?? '')
  if (status === 401 || status === 403) return { kind: 'session_dead', status, message: text.slice(0, 200) }
  if (status === 402) return { kind: 'hard_credit', status, message: text.slice(0, 200) }
  if (status === 429) {
    return isCreditExhaustion(text)
      ? { kind: 'hard_credit', status, message: text.slice(0, 200) }
      : { kind: 'soft_rate', status, message: text.slice(0, 200) }
  }
  if (status === 404 || status === 405) return { kind: 'not_found', status, message: text.slice(0, 200) }
  if (status >= 500) return { kind: 'server', status, message: text.slice(0, 200) }
  return { kind: 'client', status, message: text.slice(0, 200) }
}

/**
 * 归类「流里那片 error 事件」。
 *
 * 上游有时先回 200 再在 SSE 里报错（额度在生成过程中用完就是这种），此时状态码
 * 给不出任何信息，只能看正文。归类结果与 HTTP 失败共用同一套 kind，好让上层用
 * 同一套冷却与换号规则处理。
 */
export function classifyStreamFailure(text) {
  const message = String(text ?? '').slice(0, 200)
  if (isCreditExhaustion(message)) return { kind: 'hard_credit', status: 200, message }
  if (/\b(?:401|403)\b|unauthori[sz]ed|session expired/i.test(message)) return { kind: 'session_dead', status: 200, message }
  if (/\b429\b|rate.?limit/i.test(message)) return { kind: 'soft_rate', status: 200, message }
  return { kind: 'server', status: 200, message }
}

/**
 * @param {{baseUrlFor?: (account: object) => string}} options
 * @returns {{streamChat: (account: object, bodyText: string, signal?: AbortSignal) => Promise<object>}}
 */
export function createChatUpstream(options = {}) {
  const baseUrlFor = options.baseUrlFor ?? (account => chatBaseOf(account.region))

  return {
    /**
     * @returns {Promise<{ok: true, response: Response} | {ok: false, kind: string, status: number, message: string}>}
     */
    async streamChat(account, bodyText, signal) {
      const base = baseUrlFor(account)
      // 宿主按新约定写请求体，上游只认旧写法；差一处就是整条 400，所以每次转发前整形。
      const body = prepareChatBody(bodyText)
      let last = { ok: false, kind: 'server', status: 0, message: '没有可用的聊天端点' }

      for (const path of chatPaths(account.region)) {
        let response
        try {
          response = await fetch(`${base}${path}`, {
            method: 'POST',
            headers: chatHeaders(account),
            body,
            ...(signal === undefined ? {} : { signal }),
          })
        } catch (error) {
          // 调用方取消不是账号问题，必须原样上抛，不能换账号重试。
          if (signal?.aborted === true) return { ok: false, kind: 'aborted', status: 0, message: '请求已取消' }
          last = { ok: false, kind: 'server', status: 0, message: error instanceof Error ? error.message : String(error) }
          continue
        }
        if (response.ok) {
          captureRequest({ path, status: response.status, body, headers: chatHeaders(account) })
          return { ok: true, response }
        }

        const text = await response.text().catch(() => '')
        // 排查用：每条请求记一行概要，被拒的再记完整请求体，写入数据目录的 capture.jsonl。
        captureRequest({ path, status: response.status, body, headers: chatHeaders(account), response: text })
        last = { ok: false, ...classifyChatFailure(response.status, text) }
        // 只有路由落空才换路径；业务拒绝必须原样返回，换路径只会重复被拒。
        if (!isPathMiss(response.status)) return last
      }
      return last
    },
  }
}

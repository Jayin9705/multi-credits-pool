/**
 * 宿主消息词汇 ↔ WorkBuddy 上游的 Chat Completions 形状，以及把上游 SSE 读成
 * 宿主认识的 `StreamChunk`。
 *
 * 这一层是原生适配器的核心。以前这些转换发生在本地代理里：宿主把请求打成 HTTP
 * 发给回环端口，代理整形后转发，再把上游的 SSE 原样透传回去。现在适配器直接拿到
 * 宿主的 `GenerateOptions`，自己拼请求体、自己读流、自己产出分片，中间不再有
 * 回环端口，也不再需要把 provider 写进宿主设置。
 *
 * 分片协议是宿主 `@deepseek-ai/dsh-llm` 的扁平索引块协议：每个块以 `block-start`
 * 打开、以 delta 喂入、以 `block-end` 关闭，索引按到达顺序分配。
 */

/** 上游工具名长度上限，超了会被上游判成非法调用。 */
const MAX_TOOL_NAME_LEN = 64

/** 一个消息里的内容块列表。 */
function blocksOf(content) {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  const out = []
  for (const part of content) {
    if (typeof part === 'string') out.push({ type: 'text', text: part })
    else if (part !== null && typeof part === 'object') out.push(part)
  }
  return out
}

/** 块列表里的全部文本，按出现顺序用换行拼起来。 */
function textOf(blocks) {
  const parts = []
  for (const block of blocks ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * 一个消息携带的工具结果。
 *
 * 宿主的工具结果有两种代际：V4 是独立的 `role: 'tool'` 消息，内容本身就是结果；
 * V3 是 `user` 消息里包一层 `tool-result` 块。两种都要认——只认一种，带工具的
 * 回合发到上游就会丢掉结果，模型看不出自己已经拿到答案，于是反复重发同一个调用。
 */
function toolResultsOf(message) {
  if (message?.role === 'tool') {
    const id = callIdOf(message)
    return id === null ? [] : [{ callId: id, content: blocksOf(message.content), isError: message.isError === true }]
  }
  const out = []
  for (const block of blocksOf(message?.content)) {
    if (block?.type !== 'tool-result') continue
    const id = String(block.toolCallId ?? message?.source?.callId ?? '')
    if (id === '') continue
    out.push({ callId: id, content: blocksOf(block.content), isError: block.isError === true })
  }
  return out
}

function callIdOf(message) {
  const id = String(message?.toolCallId ?? message?.source?.callId ?? '')
  return id === '' ? null : id
}

/**
 * 丢掉没有结果的工具调用，以及没有调用可答的结果。
 *
 * 上游要求每个工具调用后面紧跟它的结果。一个回合在两者之间被打断（工具没起来、
 * 用户取消、宿主崩了）就会在历史里留下半截，重放它不只是不整洁：上游会回
 * `400 invalid_request_error`，而且此后这段会话的每一个回合都会失败，不只是坏掉
 * 的那一个。在这里修一次，覆盖所有上游形状。
 */
export function repairToolPairing(messages) {
  const list = Array.isArray(messages) ? messages : []
  const answered = new Set()
  for (const message of list) {
    for (const result of toolResultsOf(message)) answered.add(result.callId)
  }

  const keptCalls = new Set()
  const out = []
  for (const message of list) {
    const results = toolResultsOf(message)
    if (results.length > 0) {
      if (message.role === 'tool') {
        if (keptCalls.has(results[0].callId)) out.push(message)
        continue
      }
      const kept = new Set(results.filter(result => keptCalls.has(result.callId)).map(result => result.callId))
      const blocks = blocksOf(message.content)
      const rest = blocks.filter(block => block?.type !== 'tool-result'
        || kept.has(String(block.toolCallId ?? message.source?.callId ?? '')))
      if (rest.length === blocks.length) out.push(message)
      else if (rest.length > 0) out.push({ ...message, content: rest })
      continue
    }
    // 没有调用 id 可答的工具消息答不了任何东西，而请求体里空的 tool_call_id
    // 会让整个回合被判 400。
    if (message?.role === 'tool') continue
    if (message?.role !== 'assistant') {
      out.push(message)
      continue
    }
    const blocks = blocksOf(message.content)
    const toolBlocks = blocks.filter(block => block?.type === 'tool-call')
    // 没有名字的调用执行不了，而且它一旦被回答过就永远留在历史里，此后每个回合
    // 都会 400。按「未回答」处理，连同它的结果一起丢掉。
    const calls = toolBlocks.filter(block => answered.has(String(block.id ?? '')) && String(block.name ?? '') !== '')
    for (const call of calls) keptCalls.add(String(call.id))
    if (calls.length === toolBlocks.length) {
      if (calls.length > 0 || blocks.some(block => block?.type === 'text' && block.text)) out.push(message)
      continue
    }
    if (calls.length === 0) {
      // 只带死调用的助手回合没有任何模型该继续相信的内容；文本留下，调用丢掉。
      if (blocks.some(block => block?.type === 'text' && block.text)) {
        out.push({ ...message, content: blocks.filter(block => block?.type !== 'tool-call') })
      }
      continue
    }
    out.push({ ...message, content: blocks.filter(block => block?.type !== 'tool-call' || calls.includes(block)) })
  }

  return out
}

/**
 * 把宿主消息投影成上游认的 Chat Completions 消息列表。
 *
 * 助手回合的推理内容不回放：上游只接受可见文本与工具调用，把思考再喂回去既没有
 * 意义也占额度。图片块按纯文本路由处理——本插件登记的所有模型都声明 `text`
 * 输入模态，宿主在分发前已经把图片投影成占位文本，这里再遇到就丢掉。
 */
export function toChatMessages(messages) {
  const out = []
  for (const message of messages ?? []) {
    const results = toolResultsOf(message)
    if (results.length > 0) {
      for (const result of results) {
        const text = textOf(result.content)
        out.push({ role: 'tool', tool_call_id: result.callId, content: text || '(no output)' })
      }
    }
    if (message.role === 'tool') continue

    const blocks = blocksOf(message.content).filter(block => block?.type !== 'tool-result')
    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(blocks)
      if (text) out.push({ role: 'system', content: text })
      continue
    }
    if (message.role === 'assistant') {
      const text = textOf(blocks)
      const calls = []
      for (const block of blocks) {
        if (block?.type !== 'tool-call') continue
        calls.push({
          id: String(block.id ?? ''),
          type: 'function',
          function: {
            name: String(block.name ?? ''),
            arguments: typeof block.arguments === 'string' ? block.arguments : '{}',
          },
        })
      }
      if (!text && calls.length === 0) continue
      const entry = { role: 'assistant', content: text || null }
      if (calls.length > 0) entry.tool_calls = calls
      out.push(entry)
      continue
    }
    const parts = []
    for (const block of blocks) {
      if (block?.type === 'text' && block.text) parts.push({ type: 'text', text: block.text })
    }
    if (parts.length === 0) continue
    out.push({
      role: 'user',
      content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
    })
  }
  return out
}

/** 宿主工具定义 → 上游的 `function` 形状。 */
export function toToolDefs(tools) {
  const list = []
  for (const tool of tools ?? []) {
    // 宿主给的是扁平的 `{name, description, parameters}`；已经说 OpenAI 话的调用方
    // 会包一层 `function`。两种都认，否则工具会静默地一个都不发。
    const source = tool && typeof tool.function === 'object' && tool.function !== null && !Array.isArray(tool.function)
      ? tool.function
      : tool
    const name = String(source?.name ?? '').trim()
    if (!name) continue
    const parameters = source.parameters && typeof source.parameters === 'object' && !Array.isArray(source.parameters)
      ? source.parameters
      : { type: 'object', properties: {} }
    list.push({
      type: 'function',
      function: {
        name: name.slice(0, MAX_TOOL_NAME_LEN),
        description: typeof source.description === 'string' ? source.description : '',
        parameters,
      },
    })
  }
  return list
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 上游的 `usage` → 宿主的 TokenUsage。
 *
 * 宿主的计数规则是「互不重叠」：`inputTokens` 只算没命中缓存的那部分，所以要把
 * OpenAI 的 `prompt_tokens` 总数减去缓存命中。`prompt_tokens_details` 是可选的，
 * 缺省时必须先补 0 再相减——直接读 `undefined` 会让 `inputTokens` 变成 `NaN`，
 * 而宿主的会话日志拒收非有限数。
 */
export function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const prompt = finite(usage.prompt_tokens ?? usage.input_tokens)
  const completion = finite(usage.completion_tokens ?? usage.output_tokens)
  const cached = finite(usage.prompt_tokens_details?.cached_tokens) ?? 0
  const reasoning = finite(usage.completion_tokens_details?.reasoning_tokens)
  if (prompt === undefined && completion === undefined) return undefined
  const out = {
    inputTokens: Math.max(0, (prompt ?? 0) - cached),
    outputTokens: completion ?? 0,
  }
  if (cached > 0) out.cacheReadTokens = cached
  if (reasoning !== undefined && reasoning > 0) out.reasoningTokens = reasoning
  out.totalTokens = (prompt ?? 0) + (completion ?? 0)
  return out
}

/** 上游的结束标记 → 宿主的结束原因。 */
export function finishReasonOf(token) {
  if (token === 'tool_calls' || token === 'tool_use' || token === 'function_call') return { kind: 'tool-calls' }
  if (token === 'length' || token === 'max_tokens' || token === 'max_output_tokens') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

/** 上游可能在流里报错，正文里带额度耗尽之类的说法。 */
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
 * DeepSeek v4 系模型偶尔会把内部的控制标记漏进可见文本。把 `<…>` 片段从流出的
 * 文本里擦掉；可能是标记开头的尾巴先扣住，等下一个 delta 决定它是正文还是标记。
 */
const DSML_OPENING = '<' + 'ds_system'
const DSML_TAG = /<ds_system[^>]*>/g

function createDsmlScrubber() {
  let held = ''
  return {
    push(delta) {
      let text = held + delta
      held = ''
      const cut = text.lastIndexOf('<')
      if (cut !== -1) {
        const tail = text.slice(cut)
        if (DSML_OPENING.startsWith(tail)) {
          held = tail
          text = text.slice(0, cut)
        }
      }
      return text.replace(DSML_TAG, '')
    },
    flush() {
      const out = held
      held = ''
      if (out === '' || DSML_OPENING.startsWith(out)) return ''
      return out.replace(DSML_TAG, '')
    },
  }
}

/**
 * 把上游的 SSE 读成宿主分片。
 *
 * 分片在解析每一帧时同步产出，读完一帧就把 outbox 排空，所以生成器不需要任何
 * 竞速或轮询就能让 delta 持续流出。
 *
 * @param {AsyncIterable<Uint8Array|string>} body 上游响应体
 * @param {{signal?: AbortSignal}} [options]
 * @yields {object} 宿主 StreamChunk
 * @returns {Promise<{usage?: object, finish?: string, sawFinish: boolean, sawText: boolean, sawToolCall: boolean, sawReasoning: boolean, brokenToolCall: boolean}>}
 */
export async function * readChatStream(body, options = {}) {
  const decoder = new TextDecoder('utf-8')
  const outbox = []
  const emit = chunk => outbox.push(chunk)
  const sink = createSink(emit)
  const state = {
    usage: undefined,
    finish: undefined,
    sawFinish: false,
    sawText: false,
    sawToolCall: false,
    sawReasoning: false,
    brokenToolCall: false,
  }
  let buffer = ''

  const feed = payload => {
    if (payload.usage) {
      const mapped = mapUsage(payload.usage)
      if (mapped !== undefined) state.usage = mapped
    }
    for (const choice of payload.choices ?? []) {
      const delta = choice.delta ?? {}
      const reasoning = reasoningOf(delta)
      if (reasoning !== undefined) {
        state.sawReasoning = true
        sink.reasoning(reasoning)
      }
      if (typeof delta.content === 'string' && delta.content !== '') {
        state.sawText = true
        sink.text(delta.content)
      }
      for (const call of delta.tool_calls ?? []) {
        state.sawToolCall = true
        sink.toolCall(call)
      }
      if (choice.finish_reason) {
        state.finish = choice.finish_reason
        state.sawFinish = true
      }
    }
  }

  const drain = function * () {
    while (outbox.length > 0) yield outbox.shift()
  }

  try {
    for await (const chunk of body) {
      if (options.signal?.aborted === true) break
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const text = line.trim()
        if (!text.startsWith('data:')) continue
        const payload = text.slice(5).trim()
        if (payload === '' || payload === '[DONE]') continue
        let parsed
        try {
          parsed = JSON.parse(payload)
        } catch {
          continue
        }
        if (parsed === null || typeof parsed !== 'object') continue
        // 上游先回 200 再把拒绝放进流里：额度在生成过程中用完就是这种。
        if (parsed.error !== undefined && parsed.error !== null) {
          const message = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error)
          throw Object.assign(new Error(message), { streamError: true, upstream: message })
        }
        feed(parsed)
        yield * drain()
      }
    }
    buffer += decoder.decode()
    if (buffer !== '') {
      const text = buffer.trim()
      if (text.startsWith('data:')) {
        const payload = text.slice(5).trim()
        if (payload !== '' && payload !== '[DONE]') {
          try {
            const parsed = JSON.parse(payload)
            if (parsed !== null && typeof parsed === 'object' && parsed.error === undefined) feed(parsed)
          } catch {
            // 半截帧丢掉：流已经结束了，补不回来。
          }
        }
      }
    }
    sink.closeAll()
    if (sink.brokenToolCall) state.brokenToolCall = true
    yield * drain()
    return state
  } catch (error) {
    sink.closeAll()
    yield * drain()
    throw error
  }
}

/** 思考内容可能挂在几个不同的字段名下，取第一个非空的。 */
const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_text', 'thinking']

function reasoningOf(delta) {
  for (const field of REASONING_FIELDS) {
    const value = delta[field]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/**
 * 分片累加器：把上游的 delta 攒成宿主认识的块。
 *
 * 工具调用的索引是上游的累加键；没有索引的调用用 id 区分，两者都没有就续在前
 * 一个调用后面——把没有索引的调用都归到同一个常量键，会把并行的多个调用合并成
 * 一个块，id 互相覆盖。
 */
function createSink(emit) {
  let next = 0
  const open = new Map()
  let lastToolKey
  const dsml = createDsmlScrubber()
  const sink = { brokenToolCall: false }

  const slot = (key, kind) => {
    const existing = open.get(key)
    if (existing !== undefined) return existing
    const block = {
      index: next++,
      kind,
      text: '',
      args: '',
      id: kind === 'tool-call' ? `call_${Math.random().toString(16).slice(2, 14)}` : '',
      name: '',
    }
    open.set(key, block)
    emit({ type: 'block-start', index: block.index, blockType: kind })
    return block
  }

  sink.text = delta => {
    const scrubbed = dsml.push(delta)
    if (scrubbed === '') return
    const block = slot('t', 'text')
    block.text += scrubbed
    emit({ type: 'text-delta', index: block.index, text: scrubbed })
  }

  sink.reasoning = delta => {
    const block = slot('r', 'reasoning')
    block.text += delta
    emit({ type: 'reasoning-delta', index: block.index, text: delta })
  }

  sink.toolCall = call => {
    let key
    if (call.index !== undefined && call.index !== null) {
      key = `c${call.index}`
      lastToolKey = key
    } else if (typeof call.id === 'string' && call.id !== '') {
      key = `cid:${call.id}`
      lastToolKey = key
    } else {
      key = lastToolKey ?? 'c0'
    }
    const block = slot(key, 'tool-call')
    if (typeof call.id === 'string' && call.id !== '') block.id = call.id
    const name = call.function?.name
    if (typeof name === 'string' && name !== '') block.name = name
    const args = call.function?.arguments
    if (typeof args === 'string' && args !== '') {
      block.args += args
      // 参数可能比名字先到。宿主会逐帧做无损 JSON 快照，自己的 `undefined`
      // 字段会被直接拒绝，所以名字未知时干脆不带这个字段。
      const named = block.name !== '' ? { name: block.name } : {}
      emit({ type: 'tool-call-delta', index: block.index, id: block.id, ...named, argumentsDelta: args })
    }
  }

  sink.closeAll = () => {
    const spill = dsml.flush()
    let spilled = false
    for (const block of open.values()) {
      if (block.kind === 'text') {
        if (!spilled && spill !== '') {
          spilled = true
          block.text += spill
          emit({ type: 'text-delta', index: block.index, text: spill })
        }
        if (block.text !== '') emit({ type: 'block-end', index: block.index, block: { type: 'text', text: block.text } })
        continue
      }
      if (block.kind === 'reasoning') {
        if (block.text !== '') emit({ type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } })
        continue
      }
      // 参数解析不出来的调用执行不了。上游在输出上限把 JSON 从中间截断时照样
      // 报 `tool_calls`，所以结束标记本身不可信；这里降级成 max-tokens，让宿主
      // 的组装器把这个调用剪掉，而不是执行它然后看模型反复重试。
      try {
        JSON.parse(block.args === '' ? '{}' : block.args)
      } catch {
        sink.brokenToolCall = true
      }
      // 从没学到名字的调用同样执行不了：宿主会把它当成 `unknown tool ""` 执行，
      // 得到一个被回答过的毒丸，此后每个回合都失败。
      if (block.name === '') sink.brokenToolCall = true
      emit({
        type: 'block-end',
        index: block.index,
        block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.args === '' ? '{}' : block.args },
      })
    }
    open.clear()
  }

  return sink
}

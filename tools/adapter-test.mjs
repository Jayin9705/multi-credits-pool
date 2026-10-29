/**
 * 假宿主自测：不联网、不碰真实账号库，验证原生适配器这条链路。
 *
 * 覆盖的是「换掉代理之后还能不能正常工作」这件事本身：
 * - apply() 在只有 llm 服务的宿主里能起来，并注册一条路由
 * - 适配器的方法面满足宿主的校验（providerInfo / resolveModel / listModels）
 * - prepareCall 返回的 stream 能产出宿主认识的分片序列
 * - 账号轮换、故障转移、冷却、用量流水都还在
 * - 请求体整形（developer 改 system 等）仍然生效
 *
 * 跑法：node tools/adapter-test.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'mcp-adapter-test-'))
process.env.DSH_MULTI_CREDITS_POOL_DATA_DIR = ROOT
process.env.MULTI_CREDITS_POOL_CONFIG = join(ROOT, 'plugin.json')

// 关掉自动签到：apply() 启动时会补当天签到，那会真的打上游接口。
// 这里测的是适配器链路，不是签到，所以先落一份关掉的配置。
writeFileSync(
  process.env.MULTI_CREDITS_POOL_CONFIG,
  JSON.stringify({ autoCheckin: false, providerId: 'multi-credits-pool', displayName: 'multi-credits-pool' }, null, 2) + '\n',
  'utf8',
)

let passed = 0
let failed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  failures.push(detail === undefined ? name : `${name} — ${detail}`)
}

function equal(name, actual, expected) {
  check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function deepEqual(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const { CreditsPoolAdapter, buildChatBody } = await import('../src/adapter.js')
const { repairToolPairing, toChatMessages, toToolDefs, mapUsage, readChatStream, finishReasonOf } = await import('../src/wire.js')
const { prepareChatBody } = await import('../src/chat-request.js')
const { AccountRotator } = await import('../src/rotation.js')
const { upsertAccount } = await import('../src/store.js')

// ── 消息投影 ────────────────────────────────────────────────────────────────

{
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ]
  const out = toChatMessages(messages)
  equal('system 投影成一条 system', out[0].role, 'system')
  equal('system 正文', out[0].content, 'be brief')
  equal('单块 user 折成字符串', out[1].content, 'hi')
}

{
  const messages = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"p":"a"}' },
      ],
    },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'file body' }] },
  ]
  const out = toChatMessages(messages)
  equal('助手回合带 tool_calls', out[0].tool_calls.length, 1)
  equal('工具名', out[0].tool_calls[0].function.name, 'read')
  equal('工具结果投影成 role:tool', out[1].role, 'tool')
  equal('工具结果 id', out[1].tool_call_id, 'c1')
  equal('工具结果正文', out[1].content, 'file body')
}

{
  // V3 形状：user 消息里包 tool-result 块。
  const messages = [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c9', name: 'ls', arguments: '{}' }] },
    {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c9', content: [{ type: 'text', text: 'a.txt' }] }],
    },
  ]
  const out = toChatMessages(messages)
  equal('V3 工具结果也认', out[1].role, 'tool')
  equal('V3 工具结果 id', out[1].tool_call_id, 'c9')
}

{
  // 没有结果的调用必须被丢掉，否则上游此后每个回合都 400。
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'dead', name: 'read', arguments: '{}' }] },
  ]
  const repaired = repairToolPairing(messages)
  equal('未回答的调用被丢掉', repaired.length, 1)
  equal('只剩 user', repaired[0].role, 'user')
}

{
  // 没有名字的调用执行不了，按未回答处理。
  const messages = [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'x', name: '', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'x', content: [{ type: 'text', text: 'boom' }] },
  ]
  equal('无名调用连同结果一起丢掉', repairToolPairing(messages).length, 0)
}

{
  const tools = [
    { name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } },
    { type: 'function', function: { name: 'write', description: 'w', parameters: { type: 'object' } } },
    { name: '' },
  ]
  const out = toToolDefs(tools)
  equal('两种工具写法都认', out.length, 2)
  equal('扁平写法包成 function', out[0].type, 'function')
  equal('已是 function 的不重复包', out[1].function.name, 'write')
}

// ── usage 与结束原因 ────────────────────────────────────────────────────────

{
  const usage = mapUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } })
  equal('inputTokens 扣掉缓存命中', usage.inputTokens, 60)
  equal('cacheReadTokens', usage.cacheReadTokens, 40)
  equal('totalTokens', usage.totalTokens, 120)
  check('没有 NaN', Number.isFinite(usage.inputTokens) && Number.isFinite(usage.totalTokens))
}

{
  // 缺 details 时不能变 NaN：宿主的会话日志拒收非有限数。
  const usage = mapUsage({ prompt_tokens: 10, completion_tokens: 5 })
  equal('缺 details 时 inputTokens 就是 prompt', usage.inputTokens, 10)
  check('缺 details 时仍是有限数', Number.isFinite(usage.inputTokens))
}

{
  equal('tool_calls 映射', finishReasonOf('tool_calls').kind, 'tool-calls')
  equal('length 映射', finishReasonOf('length').kind, 'max-tokens')
  equal('stop 映射', finishReasonOf('stop').kind, 'stop')
  equal('未知映射成 stop', finishReasonOf('weird').kind, 'stop')
}

// ── 请求体整形仍然生效 ──────────────────────────────────────────────────────

{
  const options = {
    provider: 'multi-credits-pool',
    model: 'hy3',
    messages: [
      { role: 'developer', content: [{ type: 'text', text: 'You are an AI agent powered by DeepSeek Harness.' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
    maxTokens: 512,
    temperature: 0.3,
    reasoningEffort: 'high',
  }
  const body = buildChatBody(options, 'hy3')
  equal('模型名进请求体', body.model, 'hy3')
  equal('max_tokens 用上游字段', body.max_tokens, 512)
  equal('temperature', body.temperature, 0.3)
  equal('推理档位', body.reasoning_effort, 'high')
  equal('强制流式', body.stream, true)

  const prepared = JSON.parse(prepareChatBody(JSON.stringify(body)))
  equal('developer 改成 system', prepared.messages[0].role, 'system')
  check('自称被换成中性说法', !/powered by/i.test(prepared.messages[0].content), prepared.messages[0].content)
  check('带上 include_usage', prepared.stream_options?.include_usage === true)
}

{
  // 上游把宿主那两行 @路径说明当「非官方客户端」指纹：与产品名同时出现就回
  // 400 code=11128。这里锁住改写，防止以后有人把这段删掉。
  const body = buildChatBody({
    provider: 'multi-credits-pool',
    model: 'hy3',
    messages: [
      {
        role: 'system',
        content: [{
          type: 'text',
          text: 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host.',
        }],
      },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
  }, 'hy3')
  const prepared = JSON.parse(prepareChatBody(JSON.stringify(body)))
  const system = prepared.messages[0].content
  check('@路径指纹被改写', !/Tokens prefixed with @/.test(system), system)
  check('相对路径指纹被改写', !/Relative paths resolve from the workspace root/.test(system), system)
  check('@ 语义仍然传达', /@/.test(system) && /workspace root/.test(system), system)
}

// ── 适配器方法面 ────────────────────────────────────────────────────────────

function makeAdapter(overrides = {}) {
  const rotator = new AccountRotator({ strategy: 'sticky' })
  const models = [
    { id: 'hy3', name: 'Hy3', contextWindow: 192000, maxTokens: 64000, reasoningEfforts: { high: 'high' } },
    { id: 'plain', name: 'Plain', contextWindow: 128000, maxTokens: 8000 },
  ]
  return new CreditsPoolAdapter({
    accountsOf: () => overrides.accounts ?? [],
    rotator,
    modelsOf: () => models,
    providerId: 'multi-credits-pool',
    displayName: 'multi-credits-pool',
    defaultContextWindow: 200000,
    defaultMaxTokens: 64000,
    ...overrides,
  })
}

{
  const adapter = makeAdapter()
  const info = adapter.providerInfo('multi-credits-pool')
  equal('providerInfo.id 等于路由名', info.id, 'multi-credits-pool')
  check('providerInfo.name 非空', typeof info.name === 'string' && info.name.length > 0)

  const models = await adapter.listModels('multi-credits-pool')
  equal('listModels 数量', models.length, 2)
  equal('listModels 带 provider', models[0].provider, 'multi-credits-pool')
  deepEqual('纯文本路由声明 text 模态', models[0].inputModalities, ['text'])
}

{
  const adapter = makeAdapter()
  const resolved = await adapter.resolveModel('multi-credits-pool', 'hy3')
  equal('resolveModel.id 原样返回', resolved.id, 'hy3')
  equal('resolveModel.provider 原样返回', resolved.provider, 'multi-credits-pool')
  equal('上下文窗口来自清单', resolved.context.contextWindow, 192000)
  equal('defaultMaxTokens 来自清单', resolved.defaultMaxTokens, 64000)
  check('推理档位折成 efforts 数组', Array.isArray(resolved.reasoning?.efforts))
  equal('档位 id', resolved.reasoning.efforts[0].id, 'high')
  check('档位 name 非空', resolved.reasoning.efforts[0].name.length > 0)

  const plain = await adapter.resolveModel('multi-credits-pool', 'plain')
  equal('没有档位声明就不给 reasoning', plain.reasoning, undefined)
  check('未知模型也返回合法元数据', plain.context.contextWindow > 0 && plain.defaultMaxTokens > 0)
}

{
  const adapter = makeAdapter()
  const policy = adapter.providerRetryPolicy()
  check('重试策略是冻结的', Object.isFrozen(policy))
  check('欠费码在可重试列表里', policy.retryableCodes.includes('ACCOUNT_QUOTA'))
  check('QUOTA 也在', policy.retryableCodes.includes('QUOTA'))
}

// ── 流：没有账号时给出可判定的失败 ──────────────────────────────────────────

async function collect(iterator) {
  const chunks = []
  while (true) {
    const row = await iterator.next()
    if (row.done === true) return { chunks, value: row.value }
    chunks.push(row.value)
  }
}

{
  const adapter = makeAdapter({ accounts: [] })
  const call = await adapter.prepareCall('multi-credits-pool', 'hy3')
  const { chunks } = await collect(call.stream({ provider: 'multi-credits-pool', model: 'hy3', messages: [] }))
  const finish = chunks.find(chunk => chunk.type === 'finish')
  check('没有账号时以 finish 结束', finish !== undefined)
  equal('没有账号时是 error', finish.reason.kind, 'error')
  equal('没有账号时码是 INVALID_CREDENTIAL', finish.reason.failure.code, 'INVALID_CREDENTIAL')
}

{
  const adapter = makeAdapter({ accounts: [] })
  const call = await adapter.prepareCall('multi-credits-pool', 'nope')
  const { chunks } = await collect(call.stream({ provider: 'multi-credits-pool', model: 'nope', messages: [] }))
  const finish = chunks.find(chunk => chunk.type === 'finish')
  equal('未知模型是 error', finish.reason.kind, 'error')
}

// ── 流读取：把上游 SSE 读成宿主分片 ─────────────────────────────────────────

function sseBody(lines) {
  return (async function * () {
    for (const line of lines) yield new TextEncoder().encode(line)
  })()
}

{
  const body = sseBody([
    'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}\n',
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
    'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n',
    'data: {"usage":{"prompt_tokens":12,"completion_tokens":3}}\n',
    'data: [DONE]\n',
  ])
  const { chunks, value } = await collect(readChatStream(body))
  const types = chunks.map(chunk => chunk.type)
  check('有 block-start', types.includes('block-start'))
  check('有 reasoning-delta', types.includes('reasoning-delta'))
  check('有 text-delta', types.includes('text-delta'))
  check('有 block-end', types.includes('block-end'))
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  equal('文本拼回来', text, 'Hello world')
  equal('结束标记记录', value.finish, 'stop')
  equal('usage 记下来了', value.usage.outputTokens, 3)
  equal('usage 的输入侧', value.usage.inputTokens, 12)
  check('reasoning 标记为真', value.sawReasoning === true)
}

{
  // 工具调用：参数分片到达，块关闭时带上完整 JSON。
  const body = sseBody([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read","arguments":"{\\"p\\":"}}]}}]}\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
    'data: [DONE]\n',
  ])
  const { chunks, value } = await collect(readChatStream(body))
  const end = chunks.find(c => c.type === 'block-end' && c.block.type === 'tool-call')
  check('工具块关闭了', end !== undefined)
  equal('工具名', end.block.name, 'read')
  equal('工具 id', end.block.id, 'call_a')
  equal('参数拼完整', end.block.arguments, '{"p":"a.txt"}')
  equal('结束原因是 tool_calls', value.finish, 'tool_calls')
  check('没有标记成坏调用', value.brokenToolCall === false)
}

{
  // 参数被截断：必须标记成坏调用，让宿主剪掉它而不是执行半截。
  const body = sseBody([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"read","arguments":"{\\"p\\":"}}]}}]}\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
    'data: [DONE]\n',
  ])
  const { value } = await collect(readChatStream(body))
  check('截断的参数标记成坏调用', value.brokenToolCall === true)
}

{
  // 流里报错：额度在生成过程中用完就是这种。
  const body = sseBody([
    'data: {"choices":[{"delta":{"content":"partial"}}]}\n',
    'data: {"error":{"message":"Credits exhausted","code":14018}}\n',
  ])
  let caught
  try {
    await collect(readChatStream(body))
  } catch (error) {
    caught = error
  }
  check('流内错误被抛出', caught !== undefined)
  check('标记成流内错误', caught?.streamError === true)
  check('正文带额度耗尽字样', /exhausted/i.test(caught.message))
}

{
  // 并行工具调用：没有 index 时按 id 分开，不能合并成一个块。
  const body = sseBody([
    'data: {"choices":[{"delta":{"tool_calls":[{"id":"a","function":{"name":"x","arguments":"{}"}}]}}]}\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"id":"b","function":{"name":"y","arguments":"{}"}}]}}]}\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n',
    'data: [DONE]\n',
  ])
  const { chunks } = await collect(readChatStream(body))
  const ends = chunks.filter(c => c.type === 'block-end' && c.block.type === 'tool-call')
  equal('两个调用各成一个块', ends.length, 2)
  deepEqual('两个名字都在', ends.map(e => e.block.name).sort(), ['x', 'y'])
}

// ── 轮换与故障转移 ──────────────────────────────────────────────────────────

{
  // 上游 402（额度耗尽）换下一个账号，并给第一个打冷却。
  const rotator = new AccountRotator({ strategy: 'sticky' })
  const accounts = [
    { id: 'a1', region: 'cn', accessToken: 't1', uid: 'u1' },
    { id: 'a2', region: 'cn', accessToken: 't2', uid: 'u2' },
  ]
  for (const account of accounts) upsertAccount(account)

  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const auth = init?.headers?.Authorization ?? ''
    calls.push(auth)
    if (auth.includes('t1')) {
      return new Response('{"error":"credits exhausted"}', { status: 402 })
    }
    const sse = [
      'data: {"choices":[{"delta":{"content":"from a2"},"finish_reason":"stop"}]}\n',
      'data: [DONE]\n',
    ].join('')
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  try {
    const usage = []
    const adapter = new CreditsPoolAdapter({
      accountsOf: () => accounts,
      rotator,
      modelsOf: () => [{ id: 'hy3', name: 'Hy3', contextWindow: 192000, maxTokens: 64000 }],
      providerId: 'multi-credits-pool',
      displayName: 'multi-credits-pool',
      defaultContextWindow: 200000,
      defaultMaxTokens: 64000,
      onUsage: entry => usage.push(entry),
    })
    const call = await adapter.prepareCall('multi-credits-pool', 'hy3')
    const { chunks } = await collect(call.stream({
      provider: 'multi-credits-pool',
      model: 'hy3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sessionId: 's1',
    }))
    const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    equal('换到第二个账号后拿到正文', text, 'from a2')
    check('第一个账号被尝试过', calls.some(auth => auth.includes('t1')))
    check('第二个账号被尝试过', calls.some(auth => auth.includes('t2')))
    check('欠费账号进了冷却', rotator.isCoolingDown('a1') === true)
    check('成功账号没进冷却', rotator.isCoolingDown('a2') === false)
    equal('记了两条流水', usage.length, 2)
    equal('第一条是失败', usage[0].ok, false)
    equal('第一条失败类别', usage[0].kind, 'hard_credit')
    equal('第二条是成功', usage[1].ok, true)
    equal('成功流水带账号', usage[1].accountId, 'a2')
    // 看板写入的固定表用 `prompt_cache_key:` 前缀，适配器必须查同一个键，
    // 否则用户在看板上固定的账号对请求不起作用。
    equal('对话键与看板一致', usage[1].conversationId, 'prompt_cache_key:s1')
  } finally {
    globalThis.fetch = originalFetch
  }
}

{
  // 全部账号都欠费：给出 ACCOUNT_QUOTA，宿主据此重试。
  const rotator = new AccountRotator({ strategy: 'sticky' })
  const accounts = [{ id: 'b1', region: 'cn', accessToken: 'x1', uid: 'v1' }]
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('{"error":"credits exhausted"}', { status: 402 })
  try {
    const adapter = new CreditsPoolAdapter({
      accountsOf: () => accounts,
      rotator,
      modelsOf: () => [{ id: 'hy3', name: 'Hy3', contextWindow: 192000, maxTokens: 64000 }],
      providerId: 'multi-credits-pool',
      displayName: 'multi-credits-pool',
      defaultContextWindow: 200000,
      defaultMaxTokens: 64000,
    })
    const call = await adapter.prepareCall('multi-credits-pool', 'hy3')
    const { chunks } = await collect(call.stream({
      provider: 'multi-credits-pool',
      model: 'hy3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))
    const finish = chunks.find(c => c.type === 'finish')
    equal('全部欠费时是 error', finish.reason.kind, 'error')
    equal('码是 ACCOUNT_QUOTA', finish.reason.failure.code, 'ACCOUNT_QUOTA')
    check('错误里点名尝试过的账号', /b1/.test(finish.reason.failure.message), finish.reason.failure.message)
  } finally {
    globalThis.fetch = originalFetch
  }
}

{
  // 取消：signal 已经 aborted 时立刻以 aborted 结束。
  const rotator = new AccountRotator({ strategy: 'sticky' })
  const accounts = [{ id: 'c1', region: 'cn', accessToken: 'z1', uid: 'w1' }]
  const adapter = new CreditsPoolAdapter({
    accountsOf: () => accounts,
    rotator,
    modelsOf: () => [{ id: 'hy3', name: 'Hy3', contextWindow: 192000, maxTokens: 64000 }],
    providerId: 'multi-credits-pool',
    displayName: 'multi-credits-pool',
    defaultContextWindow: 200000,
    defaultMaxTokens: 64000,
  })
  const controller = new AbortController()
  controller.abort()
  const call = await adapter.prepareCall('multi-credits-pool', 'hy3')
  const { chunks } = await collect(call.stream({
    provider: 'multi-credits-pool',
    model: 'hy3',
    messages: [],
    signal: controller.signal,
  }))
  const finish = chunks.find(c => c.type === 'finish')
  equal('取消时是 aborted', finish.reason.kind, 'aborted')
}

// ── apply()：只有 llm 服务的宿主 ────────────────────────────────────────────

{
  const { apply, inject, name } = await import('../src/plugin.js')
  equal('插件名', name, 'llm-multi-credits-pool')
  deepEqual('只硬依赖 llm', inject, ['llm'])

  const registered = []
  const effects = []
  const fakeCtx = {
    llm: {
      registerAdapter(providers, adapter) {
        registered.push({ providers, adapter })
        return { replace() {}, [Symbol.dispose]() {} }
      },
    },
    effect(fn) { effects.push(fn) },
    logger: { info() {}, warn() {}, error() {} },
  }
  const handle = apply(fakeCtx)
  equal('注册了一条路由', registered.length, 1)
  deepEqual('路由名是 providerId', registered[0].providers, ['multi-credits-pool'])
  equal('注册的是适配器实例', registered[0].adapter instanceof CreditsPoolAdapter, true)
  check('apply 返回注册句柄', handle !== undefined && typeof handle.replace === 'function')
  check('挂了 dispose 效果', effects.length > 0)

  // 再跑一遍适配器方法面，确认注册出去的那个实例是活的。
  const models = await registered[0].adapter.listModels('multi-credits-pool')
  check('注册的适配器能列模型', Array.isArray(models) && models.length > 0)
}

{
  // 没有 llm 服务时不能抛：宿主必须照常可用。
  const { apply } = await import('../src/plugin.js')
  let threw
  try {
    apply({ logger: { info() {}, warn() {}, error() {} } })
  } catch (error) {
    threw = error
  }
  check('没有 llm 服务时不抛', threw === undefined)
}

// ── 图片能力：按上游声明给模态，图片真的发出去 ──────────────────────────────

{
  // 上游按模型声明 supportsImages。丢掉它，选择器里所有模型都成了纯文本路由，
  // 用户一贴图就被宿主挡在门外（「当前模型不支持图片」）。
  const { parseModelCatalog } = await import('../src/model-catalog.js')
  const doc = {
    models: [
      { id: 'vision-model', name: 'V', maxInputTokens: 1000, maxOutputTokens: 100, supportsImages: true },
      { id: 'text-model', name: 'T', maxInputTokens: 1000, maxOutputTokens: 100, supportsImages: false },
      { id: 'disabled-mm', name: 'D', maxInputTokens: 1000, maxOutputTokens: 100, supportsImages: true, disabledMultimodal: true },
    ],
    agents: [{ name: 'cli', models: ['vision-model', 'text-model', 'disabled-mm'] }],
  }
  const parsed = parseModelCatalog(doc)
  const byId = Object.fromEntries(parsed.map(m => [m.id, m]))
  equal('支持图片的模型带上标记', byId['vision-model'].supportsImages, true)
  equal('不支持图片的模型标记为 false', byId['text-model'].supportsImages, false)
  equal('disabledMultimodal 优先于 supportsImages', byId['disabled-mm'].supportsImages, false)
}

{
  const rotator = new AccountRotator({ strategy: 'sticky' })
  const models = [
    { id: 'vision', name: 'V', contextWindow: 1000, maxTokens: 100, supportsImages: true },
    { id: 'text', name: 'T', contextWindow: 1000, maxTokens: 100, supportsImages: false },
  ]
  const adapter = new CreditsPoolAdapter({
    accountsOf: () => [],
    rotator,
    modelsOf: () => models,
    providerId: 'multi-credits-pool',
    displayName: 'multi-credits-pool',
    defaultContextWindow: 1000,
    defaultMaxTokens: 100,
  })
  const listed = await adapter.listModels('multi-credits-pool')
  deepEqual('listModels 给支持图片的模型两个模态', listed[0].inputModalities, ['text', 'image'])
  deepEqual('listModels 给纯文本模型一个模态', listed[1].inputModalities, ['text'])

  const vision = await adapter.resolveModel('multi-credits-pool', 'vision')
  deepEqual('resolveModel 同样声明图片', vision.inputModalities, ['text', 'image'])
  const text = await adapter.resolveModel('multi-credits-pool', 'text')
  deepEqual('resolveModel 纯文本只有一个模态', text.inputModalities, ['text'])
}

{
  // 图片块必须真的进请求体，否则模型收不到图。
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: '这是什么' },
      { type: 'image', attachment: { url: 'data:image/png;base64,AAAA' } },
    ],
  }]
  const out = toChatMessages(messages)
  check('带图片的消息保持块数组', Array.isArray(out[0].content))
  equal('文本块在', out[0].content[0].text, '这是什么')
  equal('图片块转成 image_url', out[0].content[1].type, 'image_url')
  equal('图片 URL 传下去了', out[0].content[1].image_url.url, 'data:image/png;base64,AAAA')
}

{
  // 卸载过的图片只剩占位文本，不能再当图片发。
  const messages = [{
    role: 'user',
    content: [{ type: 'image', offloaded: true, attachment: { url: 'data:image/png;base64,AAAA' } }],
  }]
  const out = toChatMessages(messages)
  equal('卸载过的图片被丢掉', out.length, 0)
}

// ── 余额解析：企业版 credit 是已用，不是总量 ────────────────────────────────

{
  const { parseEnterpriseForTest } = await import('../src/balance.js')
  if (typeof parseEnterpriseForTest === 'function') {
    // 实测响应：跑了 41 次请求的账号，credit 是 13.74（已用），limitNum 是 2000（总量）。
    const parsed = parseEnterpriseForTest({
      code: 0,
      data: { credit: 13.74, limitNum: 2000, cycleStartTime: '2026-10-01 00:00:00', cycleEndTime: '2026-10-31 23:59:59', cycleResetTime: '2026-11-01 00:00:00' },
    })
    check('企业版剩余 = 总量 - credit', Math.abs(parsed.total - 1986.26) < 0.01, String(parsed.total))
    check('企业版总量是 limitNum', parsed.totalSize === 2000, String(parsed.totalSize))
    check('企业版已用是 credit', Math.abs(parsed.packages[0].used - 13.74) < 0.01, String(parsed.packages[0].used))
    check('企业版到期日读到了 camelCase 字段', parsed.packages[0].endTime === '2026-10-31 23:59:59', String(parsed.packages[0].endTime))
  }
}

// ── 收尾 ────────────────────────────────────────────────────────────────────

rmSync(ROOT, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\nfailures:')
  for (const line of failures) console.log(`  - ${line}`)
  process.exitCode = 1
}

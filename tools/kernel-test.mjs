/**
 * 真实宿主内核验证。
 *
 * 用从 DSH 安装包里解出来的 `@deepseek-ai/dsh-llm`（真实内核，不是仿的）把
 * `LlmRuntime` 拉起来，注册本插件的适配器，然后走一遍宿主真正会走的路径：
 *
 *   registerAdapter → listProviders → listModels → resolveModelInfo
 *   → prepareCall → stream
 *
 * 这一步的意义是：假宿主测试只能证明「按我理解的契约能跑」，这里证明「按宿主
 * 真实的校验能跑」。宿主对适配器返回的每个字段都做严格校验，任何一项不合法都会
 * 以 INVALID_MODEL_* 失败，那些错误只有真实内核能报出来。
 *
 * 跑法（需要先把内核解到 ../kernel）：node tools/kernel-test.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = mkdtempSync(join(tmpdir(), 'mcp-kernel-test-'))
process.env.DSH_MULTI_CREDITS_POOL_DATA_DIR = ROOT
process.env.MULTI_CREDITS_POOL_CONFIG = join(ROOT, 'plugin.json')
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

// 内核从 ../kernel 解析：那里有 dsh-llm 及其完整依赖链。
const kernelRequire = createRequire(join(HERE, '..', 'kernel', 'noop.cjs'))
let kernel
try {
  // Windows 上 resolve 出来的是盘符路径，ESM 加载器只认 file:// URL。
  kernel = await import(pathToFileURL(kernelRequire.resolve('@deepseek-ai/dsh-llm')).href)
} catch (error) {
  console.log(`\n内核不可用：${error.message}`)
  console.log('先把内核解出来：node tools/extract-kernel.mjs（或手工放到 ../kernel）')
  rmSync(ROOT, { recursive: true, force: true })
  process.exit(2)
}

const cordis = await import(pathToFileURL(kernelRequire.resolve('@deepseek-ai/cordis')).href)
const { LlmRuntime, LlmAdapter } = kernel
check('拿到真实 LlmRuntime', typeof LlmRuntime === 'function')
check('拿到真实 LlmAdapter', typeof LlmAdapter === 'function')

// 我们的适配器应当满足宿主的 LlmAdapter 形状（宿主不强制 extends，只按方法面调用）。
const { CreditsPoolAdapter } = await import('../src/adapter.js')
const { AccountRotator } = await import('../src/rotation.js')
const { upsertAccount } = await import('../src/store.js')

const MODELS = [
  { id: 'hy3', name: 'Hy3', contextWindow: 192000, maxTokens: 64000, reasoningEfforts: { high: 'high' } },
  { id: 'plain', name: 'Plain', contextWindow: 128000, maxTokens: 8000 },
]

function makeAdapter(accounts, rotator) {
  return new CreditsPoolAdapter({
    accountsOf: () => accounts,
    rotator,
    modelsOf: () => MODELS,
    providerId: 'multi-credits-pool',
    displayName: 'multi-credits-pool',
    defaultContextWindow: 200000,
    defaultMaxTokens: 64000,
  })
}

/**
 * 真 cordis Context：LlmRuntime 是 cordis 的 Service，需要真的 ctx.reflect 才能
 * 构造。这里只搭到够跑通注册与一次调用，不模拟整个宿主。
 */
function makeHost() {
  const ctx = new cordis.Context()
  return ctx
}

// ── 注册 ────────────────────────────────────────────────────────────────────

{
  const ctx = makeHost()
  const llm = new LlmRuntime(ctx)
  ctx.llm = llm

  const rotator = new AccountRotator({ strategy: 'sticky' })
  const adapter = makeAdapter([], rotator)
  const handle = llm.registerAdapter(['multi-credits-pool'], adapter)
  check('真实内核接受注册', handle !== undefined)

  const providers = llm.listProviders()
  equal('listProviders 有一条', providers.length, 1)
  equal('provider id', providers[0].id, 'multi-credits-pool')
  equal('provider 显示名', providers[0].name, 'multi-credits-pool')

  // 模型目录：宿主从这里喂 GUI 的模型选择器。
  const models = await adapter.listModels('multi-credits-pool')
  equal('listModels 数量', models.length, 2)

  // 精确模型解析：宿主逐字段校验，任何一项不合法都会抛 INVALID_MODEL_*。
  let info
  let resolveError
  try {
    info = await llm.resolveModelInfo('multi-credits-pool', 'hy3')
  } catch (error) {
    resolveError = error
  }
  check('resolveModelInfo 通过宿主校验', resolveError === undefined, resolveError?.message)
  if (info !== undefined) {
    equal('info.provider', info.provider, 'multi-credits-pool')
    equal('info.id', info.id, 'hy3')
    equal('info.context.contextWindow', info.context.contextWindow, 192000)
    equal('info.defaultMaxTokens', info.defaultMaxTokens, 64000)
    check('reasoning.efforts 被宿主接受', Array.isArray(info.reasoning?.efforts) && info.reasoning.efforts.length === 1)
    equal('effort id', info.reasoning.efforts[0].id, 'high')
  }

  // 没有推理声明的模型：宿主应当接受「没有 reasoning」这种结果。
  let plainError
  let plainInfo
  try {
    plainInfo = await llm.resolveModelInfo('multi-credits-pool', 'plain')
  } catch (error) {
    plainError = error
  }
  check('无档位模型也通过校验', plainError === undefined, plainError?.message)
  equal('无档位模型没有 reasoning', plainInfo?.reasoning, undefined)

  // 重试策略：宿主在注册时就读，格式不对会当场拒绝。
  const policy = adapter.providerRetryPolicy()
  check('重试策略是冻结对象', Object.isFrozen(policy))
  check('重试策略带 maxRetries', Number.isInteger(policy.maxRetries))
}

// ── 一次真实调用（假上游）────────────────────────────────────────────────────

{
  const ctx = makeHost()
  const llm = new LlmRuntime(ctx)
  ctx.llm = llm

  const rotator = new AccountRotator({ strategy: 'sticky' })
  const accounts = [{ id: 'k1', region: 'cn', accessToken: 'tok-k1', uid: 'ku1' }]
  upsertAccount(accounts[0])
  const adapter = makeAdapter(accounts, rotator)
  llm.registerAdapter(['multi-credits-pool'], adapter)

  const originalFetch = globalThis.fetch
  let seenBody
  globalThis.fetch = async (url, init) => {
    seenBody = JSON.parse(init.body)
    const sse = [
      'data: {"choices":[{"delta":{"content":"kernel says hi"},"finish_reason":"stop"}]}\n',
      'data: {"usage":{"prompt_tokens":7,"completion_tokens":3}}\n',
      'data: [DONE]\n',
    ].join('')
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  try {
    const chunks = []
    for await (const chunk of llm.stream({
      provider: 'multi-credits-pool',
      model: 'hy3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxTokens: 256,
    })) {
      chunks.push(chunk)
    }

    const types = chunks.map(chunk => chunk.type)
    check('真实内核跑通了流', chunks.length > 0)
    check('有 text-delta', types.includes('text-delta'))
    check('有 usage', types.includes('usage'))
    check('有 finish', types.includes('finish'))

    const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    equal('正文拼回来', text, 'kernel says hi')

    const finish = chunks.find(c => c.type === 'finish')
    equal('结束原因是 stop', finish.reason.kind, 'stop')

    const usage = chunks.find(c => c.type === 'usage')
    equal('usage 输入侧', usage.usage.inputTokens, 7)
    equal('usage 输出侧', usage.usage.outputTokens, 3)

    // 请求体确实按上游的写法发出去了。
    equal('请求体带模型名', seenBody.model, 'hy3')
    equal('请求体强制流式', seenBody.stream, true)
    equal('请求体带 max_tokens', seenBody.max_tokens, 256)

    // 宿主自己组装一遍：能拼出完整的助手消息，说明分片协议是对的。
    const { BlockAssembler } = kernel
    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)
    const blocks = assembler.blocks()
    check('宿主能组装出块', Array.isArray(blocks) && blocks.length > 0)
    equal('组装出的第一块是文本', blocks[0].type, 'text')
    equal('组装出的文本内容', blocks[0].text, 'kernel says hi')
    equal('组装器读到 usage', assembler.usage?.outputTokens, 3)
    equal('组装器读到结束原因', assembler.finish?.kind, 'stop')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// ── 上游失败时宿主拿到可判定的失败码 ────────────────────────────────────────

{
  const ctx = makeHost()
  const llm = new LlmRuntime(ctx)
  ctx.llm = llm

  const rotator = new AccountRotator({ strategy: 'sticky' })
  const accounts = [{ id: 'q1', region: 'cn', accessToken: 'tok-q1', uid: 'qu1' }]
  const adapter = makeAdapter(accounts, rotator)
  llm.registerAdapter(['multi-credits-pool'], adapter)

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('{"error":"credits exhausted"}', { status: 402 })
  try {
    const chunks = []
    for await (const chunk of llm.stream({
      provider: 'multi-credits-pool',
      model: 'hy3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      chunks.push(chunk)
    }
    const finish = chunks.find(c => c.type === 'finish')
    equal('欠费时是 error', finish.reason.kind, 'error')
    equal('欠费码是 ACCOUNT_QUOTA', finish.reason.failure.code, 'ACCOUNT_QUOTA')
    check('宿主认得出这是额度问题', kernel.isQuotaExceededError?.(finish.reason.failure) === true
      || finish.reason.failure.code === 'ACCOUNT_QUOTA')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// ── 注销 ────────────────────────────────────────────────────────────────────

{
  const ctx = makeHost()
  const llm = new LlmRuntime(ctx)
  ctx.llm = llm
  const rotator = new AccountRotator({ strategy: 'sticky' })
  const adapter = makeAdapter([], rotator)
  const handle = llm.registerAdapter(['multi-credits-pool'], adapter)
  equal('注册后有一条', llm.listProviders().length, 1)
  handle()
  equal('注销后没有', llm.listProviders().length, 0)
}

rmSync(ROOT, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\nfailures:')
  for (const line of failures) console.log(`  - ${line}`)
  process.exitCode = 1
}

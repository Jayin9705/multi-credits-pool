/**
 * 一键启用 / 一键禁用：visible-models 动作的批量路径。
 *
 * 全关之后 visibleModelsOf 会退回完整清单（宿主的模型选择器不能空着），
 * 所以「全部关掉」的实际效果是隐藏表里塞满全部 id。这里锁住这个行为。
 *
 * 跑法：node tools/bulk-models-test.mjs
 */
// 用假的 req/res 走真实的 handleAction 路径。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'mcp-bulk-test-'))
process.env.DSH_MULTI_CREDITS_POOL_DATA_DIR = ROOT
process.env.MULTI_CREDITS_POOL_CONFIG = join(ROOT, 'plugin.json')

const base = new URL('../src/', import.meta.url).href
const { createWebApi } = await import(base + 'web-routes.js')
const { readPluginConfig, visibleModelsOf, hiddenModelsOf } = await import(base + 'plugin-config.js')

let passed = 0
let failed = 0
const failures = []
function check(name, cond, detail) {
  if (cond) { passed++; return }
  failed++
  failures.push(detail === undefined ? name : `${name} — ${detail}`)
}

// 先落一份有 3 个模型的配置
writeFileSync(process.env.MULTI_CREDITS_POOL_CONFIG, JSON.stringify({
  providerId: 'multi-credits-pool',
  displayName: 'multi-credits-pool',
  autoCheckin: false,
  hiddenModels: [],
  models: [
    { id: 'm1', name: 'M1', contextWindow: 1000, maxTokens: 100 },
    { id: 'm2', name: 'M2', contextWindow: 1000, maxTokens: 100 },
    { id: 'm3', name: 'M3', contextWindow: 1000, maxTokens: 100 },
  ],
}, null, 2) + '\n', 'utf8')

const api = createWebApi({
  accountsOf: () => [],
  logger: { info() {}, warn() {}, error() {} },
  onModelsChange: () => {},
})

/** 走一次真实的 action 路径，返回解析后的响应体。 */
async function callAction(payload) {
  let captured
  const res = {
    writeHead(status) { this._status = status },
    end(text) { captured = JSON.parse(text) },
  }
  const bodyText = JSON.stringify(payload)
  // 真实的 req 是流：readBody 用 on('data'/'end') 读它。
  const req = {
    headers: { host: '127.0.0.1', origin: 'http://127.0.0.1', 'x-credits-key': api.actionKey },
    on(event, handler) {
      if (event === 'data') handler(Buffer.from(bodyText))
      else if (event === 'end') handler()
      return this
    },
  }
  await api.handleAction(req, res)
  return { status: res._status, body: captured }
}

// 初始：3 个全可见
check('初始全部可见', visibleModelsOf(readPluginConfig()).length === 3, String(visibleModelsOf(readPluginConfig()).length))

// 一键禁用：传空数组
{
  const r = await callAction({ action: 'visible-models', visible: [] })
  check('一键禁用返回 ok', r.body?.ok === true, JSON.stringify(r.body))
  const cfg = readPluginConfig()
  check('隐藏表里塞满 3 个', hiddenModelsOf(cfg).length === 3, JSON.stringify(hiddenModelsOf(cfg)))
  // 全关之后 visibleModelsOf 退回完整清单——选择器不能空着
  check('全关后仍返回完整清单（兜底）', visibleModelsOf(cfg).length === 3, String(visibleModelsOf(cfg).length))
}

// 一键启用：传全部 id
{
  const all = readPluginConfig().models.map(m => m.id)
  const r = await callAction({ action: 'visible-models', visible: all })
  check('一键启用返回 ok', r.body?.ok === true, JSON.stringify(r.body))
  const cfg = readPluginConfig()
  check('隐藏表清空', hiddenModelsOf(cfg).length === 0, JSON.stringify(hiddenModelsOf(cfg)))
  check('3 个全可见', visibleModelsOf(cfg).length === 3, String(visibleModelsOf(cfg).length))
}

// 只留一个：中间态
{
  const r = await callAction({ action: 'visible-models', visible: ['m2'] })
  check('只留一个返回 ok', r.body?.ok === true, JSON.stringify(r.body))
  const cfg = readPluginConfig()
  check('隐藏表有 2 个', hiddenModelsOf(cfg).length === 2, JSON.stringify(hiddenModelsOf(cfg)))
  check('可见只剩 m2', visibleModelsOf(cfg).map(m => m.id).join(',') === 'm2', visibleModelsOf(cfg).map(m => m.id).join(','))
}

rmSync(ROOT, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\nfailures:')
  for (const line of failures) console.log(`  - ${line}`)
  process.exitCode = 1
}

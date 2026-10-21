/**
 * 账号库与签到流水。
 *
 * 与原版最本质的差别：原版把凭据存成「一个固定文件名的对象」，切换账号等于
 * 丢弃重登；这里存成数组，每个账号一条，按 id 寻址。
 *
 * 写入用「临时文件 + rename」保证读者不会看到半个文件；所有写操作前先建目录。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { accountsFile, dataDir, logFile, pinsFile } from './paths.js'
import { accountIdOf, stripBom, utc8Date } from './protocol.js'

const EMPTY = { version: 1, accounts: [] }

function ensureDir() {
  const dir = dataDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 读账号库。文件不存在或损坏都退化成空库，不抛错。 */
export function readStore() {
  const file = accountsFile()
  if (!existsSync(file)) return structuredClone(EMPTY)
  try {
    const parsed = JSON.parse(stripBom(readFileSync(file, 'utf8')))
    const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : []
    return {
      version: 1,
      accounts: accounts.filter(a => a && typeof a === 'object' && typeof a.accessToken === 'string'),
    }
  } catch {
    return structuredClone(EMPTY)
  }
}

function writeStore(state) {
  ensureDir()
  const file = accountsFile()
  const temp = join(dirname(file), `.accounts.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  renameSync(temp, file)
}

/** 所有账号（只读副本）。 */
export function listAccounts() {
  return readStore().accounts
}

export function findAccount(ref) {
  const accounts = listAccounts()
  if (!ref) return undefined
  const needle = String(ref).trim().toLowerCase()
  return accounts.find(a => a.id?.toLowerCase() === needle)
    ?? accounts.find(a => (a.label ?? '').toLowerCase() === needle)
    ?? accounts.find(a => a.uid && a.uid.toLowerCase() === needle)
}

/**
 * 新增或覆盖一个账号（按 id 判定）。
 *
 * @param {object} account 已含 accessToken / refreshToken / region / uid 等字段
 * @returns {{account: object, created: boolean}}
 */
export function upsertAccount(account) {
  const state = readStore()
  const id = account.id || accountIdOf(account)
  const existing = state.accounts.find(a => a.id === id)
  const merged = {
    ...existing,
    ...account,
    id,
    addedAt: existing?.addedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  if (existing) {
    state.accounts = state.accounts.map(a => (a.id === id ? merged : a))
  } else {
    state.accounts.push(merged)
  }
  writeStore(state)
  return { account: merged, created: !existing }
}

/** 只在账号库里替换字段，不动其它账号。 */
export function patchAccount(id, patch) {
  const state = readStore()
  const existing = state.accounts.find(a => a.id === id)
  if (!existing) return undefined
  const next = { ...existing, ...patch, updatedAt: new Date().toISOString() }
  state.accounts = state.accounts.map(a => (a.id === id ? next : a))
  writeStore(state)
  return next
}

export function deleteAccount(id) {
  const state = readStore()
  const before = state.accounts.length
  state.accounts = state.accounts.filter(a => a.id !== id)
  if (state.accounts.length === before) return false
  writeStore(state)
  return true
}

/** 追加一条签到/余额流水。一行一个 JSON，便于 grep 和后续统计。 */
export function appendLog(entry) {
  ensureDir()
  appendFileSync(logFile(), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8')
}

/** 读全部流水（容错：坏行跳过）。 */
export function readLog() {
  const file = logFile()
  if (!existsSync(file)) return []
  const rows = []
  for (const line of stripBom(readFileSync(file, 'utf8')).split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      const row = JSON.parse(text)
      if (row && typeof row === 'object') rows.push(row)
    } catch {
      // 坏行跳过：流水不是关键数据，不能因为一行脏数据让汇总整体失败。
    }
  }
  return rows
}

/** 某账号今天是否已经签到过（以流水为准，跨进程可靠）。 */
export function checkedInToday(accountId, nowMs = Date.now()) {
  const today = utc8Date(nowMs)
  return readLog().some(row => row.kind === 'checkin'
    && row.accountId === accountId
    && row.date === today
    && (row.status === 'claimed' || row.status === 'already-claimed'))
}

/** 读手动固定表；文件不存在或坏掉时按空表处理。 */
export function readPins() {
  const file = pinsFile()
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(stripBom(readFileSync(file, 'utf8')))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const pins = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && key !== '' && value !== '') pins[key] = value
    }
    return pins
  } catch {
    // 固定表坏掉不该拦住插件启动：当作没固定过，用户重新选一次即可。
    return {}
  }
}

/** 写手动固定表（原子写，避免半截文件）。 */
export function writePins(pins) {
  ensureDir()
  const file = pinsFile()
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, JSON.stringify(pins ?? {}, null, 2) + '\n', 'utf8')
  renameSync(temp, file)
  return file
}

/**
 * 从本机 DSH 安装包里解出 `@deepseek-ai/dsh-llm` 及其依赖链，供 kernel-test 使用。
 *
 * 为什么需要这一步：`dsh-llm` 是宿主随安装包一起下发的，不在 npm 上，也不在
 * profile 的 node_modules 里（那里只有一个空的 `@deepseek-ai` 目录）。想用真实
 * 内核验证适配器，只能从 `app.asar` 里把它解出来。
 *
 * 解出来的东西落在 `../kernel`，不进版本库。
 *
 * 跑法：node tools/extract-kernel.mjs [DSH 安装目录]
 * 缺省按环境变量与常见位置找。
 */
import { closeSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_ROOT = join(HERE, '..', 'kernel', 'node_modules')

/** 找 DSH 的安装目录：先看参数，再看环境变量，最后试几个常见位置。 */
function findInstallDir() {
  const candidates = [
    process.argv[2],
    process.env.DSH_INSTALL_DIR,
    'D:\\mirasim\\DSH',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'deepseek-harness'),
    join(process.env.PROGRAMFILES ?? '', 'DeepSeek Harness'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'resources', 'app.asar'))) return candidate
  }
  return undefined
}

const install = findInstallDir()
if (install === undefined) {
  console.error('找不到 DSH 安装目录。用法：node tools/extract-kernel.mjs "D:\\path\\to\\DSH"')
  process.exit(1)
}

const asarPath = join(install, 'resources', 'app.asar')
console.log(`从 ${asarPath} 解内核`)

// ── 读 asar 头 ──────────────────────────────────────────────────────────────

const fd = openSync(asarPath, 'r')
const header = Buffer.alloc(16)
readSync(fd, header, 0, 16, 0)
const headerSize = header.readUInt32LE(12)
const headerBuf = Buffer.alloc(headerSize)
readSync(fd, headerBuf, 0, headerSize, 16)
const tree = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/, ''))
const dataBase = 8 + header.readUInt32LE(4)

function walk(node, prefix, out) {
  for (const [key, value] of Object.entries(node.files ?? {})) {
    const full = `${prefix}/${key}`
    if (value.files) walk(value, full, out)
    else out.push({ path: full, size: value.size, offset: value.offset })
  }
  return out
}

const all = walk(tree, '', [])

function readEntry(entry) {
  const buf = Buffer.alloc(entry.size)
  readSync(fd, buf, 0, entry.size, dataBase + Number(entry.offset))
  return buf
}

// ── 沿着依赖链收集要解的包 ──────────────────────────────────────────────────

const ROOT_PKG = '/dsh/node_modules/@deepseek-ai/dsh-llm/package.json'
const rootManifest = all.find(entry => entry.path === ROOT_PKG)
if (rootManifest === undefined) {
  console.error('安装包里没有 dsh-llm，DSH 版本可能变了')
  closeSync(fd)
  process.exit(1)
}

const wanted = new Set(['@deepseek-ai/dsh-llm'])
const queue = []
const rootPkg = JSON.parse(readEntry(rootManifest).toString('utf8'))
queue.push(...Object.keys({ ...rootPkg.dependencies, ...rootPkg.peerDependencies }))

while (queue.length > 0) {
  const name = queue.shift()
  if (wanted.has(name)) continue
  wanted.add(name)
  const manifestEntry = all.find(entry => entry.path === `/dsh/node_modules/${name}/package.json`)
  if (manifestEntry === undefined) continue
  try {
    const manifest = JSON.parse(readEntry(manifestEntry).toString('utf8'))
    queue.push(...Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }))
  } catch {
    // 清单坏了就只解这个包本身，依赖留给运行时暴露
  }
}

// ── 落盘 ────────────────────────────────────────────────────────────────────

let files = 0
for (const name of wanted) {
  const prefix = `/dsh/node_modules/${name}/`
  for (const entry of all.filter(candidate => candidate.path.startsWith(prefix))) {
    const rel = entry.path.slice(prefix.length)
    const target = join(OUT_ROOT, name, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readEntry(entry))
    files += 1
  }
}

closeSync(fd)
console.log(`解出 ${wanted.size} 个包、${files} 个文件到 ${OUT_ROOT}`)
console.log('现在可以跑：node tools/kernel-test.mjs')

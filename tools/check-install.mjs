/**
 * 安装副本与仓库是否一致。
 *
 * 这个检查存在的理由：之前有几次「改了仓库、也跑了测试，但装进 profile 的
 * 副本还是旧的」，于是所有验证都在测仓库里的代码，用户那边却毫无变化。
 * 测试通过不等于装上了——这个脚本把两者逐文件比对，不一致就非零退出。
 *
 * 跑法：node tools/check-install.mjs [profile 名]
 * 缺省 profile 是 desktop。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const PROFILE = process.argv[2] ?? 'desktop'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const INSTALLED = join(DSH_HOME, 'profiles', PROFILE, 'node_modules', 'multi-credits-pool')

/** 顶层要同步的文件。 */
const TOP_FILES = ['index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE']

/**
 * 内容指纹，忽略换行符差异。
 *
 * 仓库里是 LF，装进 profile 后 git/pnpm 可能写成 CRLF（Windows 上很常见）。
 * 按原始字节比对会把「只有换行不同」也算成不一致，那种误报会让人逐渐无视
 * 这个检查，反而漏掉真正的差异。
 */
function hash(file) {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

if (!existsSync(INSTALLED)) {
  console.error(`安装副本不存在：${INSTALLED}`)
  console.error('先装一次，或者确认 profile 名对不对。')
  process.exit(2)
}

const problems = []

for (const name of TOP_FILES) {
  const from = join(REPO, name)
  const to = join(INSTALLED, name)
  if (!existsSync(from)) continue
  if (!existsSync(to)) {
    problems.push(`缺失：${name}`)
    continue
  }
  if (hash(from) !== hash(to)) problems.push(`不同：${name}`)
}

const repoFiles = readdirSync(join(REPO, 'src')).filter(name => name.endsWith('.js'))
for (const name of repoFiles) {
  const to = join(INSTALLED, 'src', name)
  if (!existsSync(to)) {
    problems.push(`缺失：src/${name}`)
    continue
  }
  if (hash(join(REPO, 'src', name)) !== hash(to)) problems.push(`不同：src/${name}`)
}

// 仓库里已经删掉、安装副本里还留着的文件，同样算不一致：
// proxy.js 就是这么在安装副本里活了好几轮。
const installedFiles = existsSync(join(INSTALLED, 'src'))
  ? readdirSync(join(INSTALLED, 'src')).filter(name => name.endsWith('.js'))
  : []
for (const name of installedFiles) {
  if (!repoFiles.includes(name)) problems.push(`多余：src/${name}`)
}

if (problems.length === 0) {
  console.log(`安装副本与仓库一致（${repoFiles.length} 个 src 文件 + ${TOP_FILES.length} 个顶层文件）`)
  console.log(`  ${INSTALLED}`)
  process.exit(0)
}

console.error(`安装副本与仓库不一致，${problems.length} 处：`)
for (const line of problems) console.error(`  ${line}`)
console.error('')
console.error('修法：把仓库的文件拷进安装副本，并删掉多余的文件。')
process.exit(1)

/**
 * tools/push-via-api.mjs —— 用 GitHub REST API 提交（git 直连 443 不通时的替代路径）
 * ============================================================================
 * 背景：`git push` 走 github.com:443，某些网络下会被阻断（connect timeout），
 *      但 `gh api` 走的是另一条链路，通常还通。
 *
 * 做法：把本地 HEAD 相对远端 HEAD 改动的文件，用 Contents API 逐个写上去。
 *
 * ⚠️ 代价：API 只能一个文件一个 commit，所以历史会被拆成 N 个同标题的 commit，
 *    而且不是真正的 git push（本地 commit sha 不会出现在远端）。
 *    **能 git push 就别用这个。** 只在「必须马上同步、git 完全不通」时用。
 *
 * 用法：
 *   node tools/push-via-api.mjs --dry-run     # 只看会改哪些文件
 *   node tools/push-via-api.mjs
 *   node tools/push-via-api.mjs --message="自定义提交信息"
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DRY = process.argv.includes('--dry-run')
const MSG_ARG = process.argv.find((a) => a.startsWith('--message='))
const REPO = process.env.GH_REPO || 'pcmxiao/dsh-douyin-bridge'
const BRANCH = process.env.GH_BRANCH || 'master'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const gh = (args, input) => execFileSync('gh', args, {
  encoding: 'utf8',
  input,
  maxBuffer: 64 * 1024 * 1024,
}).trim()

// 远端当前 HEAD
const base = JSON.parse(gh(['api', `repos/${REPO}/commits/${BRANCH}`])).sha
const subject = MSG_ARG
  ? MSG_ARG.slice('--message='.length)
  : git('log', '-1', '--pretty=%s')
console.log(`远端 HEAD: ${base}`)
console.log(`提交信息: ${subject}`)

// 相对远端改了哪些文件（A/M/D/R）
const changes = git('diff', '--name-status', base, 'HEAD')
  .split('\n').filter(Boolean).map((line) => {
    const parts = line.split('\t')
    return { status: parts[0][0], path: parts[parts.length - 1] }
  })

console.log(`改动 ${changes.length} 个文件：`)
for (const c of changes) console.log(`  ${c.status}  ${c.path}`)
if (DRY) process.exit(0)

const root = git('rev-parse', '--show-toplevel')
let done = 0
let failed = 0

for (const c of changes) {
  const apiPath = `repos/${REPO}/contents/${c.path.split('/').map(encodeURIComponent).join('/')}`

  // 先取远端已有 blob 的 sha（更新/删除都要带；取不到 = 新文件）
  let sha = ''
  try {
    sha = JSON.parse(gh(['api', `${apiPath}?ref=${BRANCH}`])).sha
  } catch { /* 新文件 */ }

  try {
    if (c.status === 'D') {
      if (!sha) { console.log(`  · 跳过 ${c.path}（远端本来就没有）`); continue }
      gh(['api', '--method', 'DELETE', apiPath,
        '-f', `message=${subject}`, '-f', `sha=${sha}`, '-f', `branch=${BRANCH}`])
      console.log(`  ✔ 删除 ${c.path}`)
    } else {
      const content = readFileSync(join(root, c.path)).toString('base64')
      const args = ['api', '--method', 'PUT', apiPath,
        '-f', `message=${subject}`,
        '-f', `content=${content}`,
        '-f', `branch=${BRANCH}`]
      if (sha) args.push('-f', `sha=${sha}`)
      gh(args)
      console.log(`  ✔ ${c.status === 'A' ? '新增' : '更新'} ${c.path}`)
    }
    done++
  } catch (e) {
    failed++
    console.log(`  ✘ ${c.path} —— ${String(e.stderr || e.message).split('\n')[0]}`)
  }
}

console.log(`\n${failed ? '✘' : '✔'} 完成 ${done}/${changes.length} 个文件`)
if (failed) process.exit(1)
console.log('\n提示：API 会生成 N 个同标题 commit。想合并历史，等 git 通了做一次')
console.log('      git reset --soft <base> && git commit，再 git push --force。')

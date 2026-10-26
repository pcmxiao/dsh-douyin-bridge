/**
 * tools/push-blobs.mjs —— 用 GitHub Git Data API 直接推（不依赖本地历史）
 * ============================================================================
 * 为什么需要这个：
 *   `push-via-api.mjs` 假设「远端 HEAD 在本地存在」，靠 `git diff <remote> HEAD`
 *   算改动。但 API 造的 commit 本地没有 ⇒ `fatal: bad object`。
 *
 *   这个脚本不碰历史，只做「本地文件 → 远端 tree → 新 commit → 移动分支」，
 *   全程用 Git Data API，本地不需要有远端那些 commit。
 *
 * 用法：
 *   node tools/push-blobs.mjs --dry-run
 *   node tools/push-blobs.mjs --message="..."
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const DRY = process.argv.includes('--dry-run')
const MSG_ARG = process.argv.find((a) => a.startsWith('--message='))
const REPO = process.env.GH_REPO || 'pcmxiao/dsh-douyin-bridge'
const BRANCH = process.env.GH_BRANCH || 'master'

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
const gh = (args, input) => execFileSync('gh', args, {
  encoding: 'utf8', input, maxBuffer: 128 * 1024 * 1024,
}).trim()

// ① 远端当前 HEAD 与完整 tree
const headSha = JSON.parse(gh(['api', `repos/${REPO}/commits/${BRANCH}`])).sha
const treeJson = JSON.parse(gh(['api', `repos/${REPO}/git/trees/${headSha}?recursive=1`]))
const remoteBlobs = new Map((treeJson.tree || []).filter((x) => x.type === 'blob').map((x) => [x.path, x.sha]))

// ② 本地 HEAD 的文件，逐个比对 blob sha
const localFiles = git('ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter(Boolean)
const changed = []
for (const f of localFiles) {
  const localSha = git('rev-parse', `HEAD:${f}`)
  if (remoteBlobs.get(f) !== localSha) changed.push(f)
}

const subject = MSG_ARG
  ? MSG_ARG.slice('--message='.length)
  : git('log', '-1', '--format=%s')

console.log(`远端 HEAD: ${headSha}`)
console.log(`提交信息: ${subject}`)
console.log(`改动 ${changed.length} 个文件：`)
for (const f of changed) console.log(`  ${f}`)

if (!changed.length) { console.log('\n没有改动，跳过'); process.exit(0) }
if (DRY) { console.log('\n(dry-run，不实际推送)'); process.exit(0) }

// ③ 逐个上传 blob
const entries = []
for (const f of changed) {
  const content = readFileSync(f)
  const b64 = content.toString('base64')
  const r = JSON.parse(gh(
    ['api', '-X', 'POST', `repos/${REPO}/git/blobs`, '--input', '-'],
    JSON.stringify({ content: b64, encoding: 'base64' }),
  ))
  entries.push({ path: f, mode: '100644', type: 'blob', sha: r.sha })
  console.log(`  ✔ ${f}`)
}

// ④ 用远端原 tree 做基底，覆盖改动的文件
const baseTree = treeJson.tree.filter((x) => x.type === 'blob' && !changed.includes(x.path))
const newTree = JSON.parse(gh(
  ['api', '-X', 'POST', `repos/${REPO}/git/trees`, '--input', '-'],
  JSON.stringify({
    tree: [
      ...baseTree.map((x) => ({ path: x.path, mode: x.mode || '100644', type: 'blob', sha: x.sha })),
      ...entries,
    ],
  }),
))
console.log(`新 tree: ${newTree.sha}`)

// ⑤ 建 commit（parent = 远端 HEAD）
const body = `${subject}\n\n（由 tools/push-blobs.mjs 通过 GitHub Git Data API 提交）`
const commit = JSON.parse(gh(
  ['api', '-X', 'POST', `repos/${REPO}/git/commits`, '--input', '-'],
  JSON.stringify({ message: body, tree: newTree.sha, parents: [headSha] }),
))
console.log(`新 commit: ${commit.sha}`)

// ⑥ 移动分支
gh(['api', '-X', 'PATCH', `repos/${REPO}/git/refs/heads/${BRANCH}`, '--input', '-'],
  JSON.stringify({ sha: commit.sha, force: false }))
console.log(`\n✔ 已推送 ${BRANCH} -> ${commit.sha.slice(0, 7)}`)

/**
 * tools/gh-grep.mjs —— 在 GitHub 仓库文件里搜关键词
 * 用法：node tools/gh-grep.mjs <owner/repo> <path> <regex> [上下文行数]
 */
import { execFileSync } from 'node:child_process'

const [repo, path, pattern, ctxN] = process.argv.slice(2)
if (!repo || !path || !pattern) {
  console.error('用法: node tools/gh-grep.mjs <owner/repo> <path> <regex> [ctx]')
  process.exit(1)
}
const res = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/contents/${path}`], {
  encoding: 'utf8',
  maxBuffer: 128 * 1024 * 1024,
}))
const lines = Buffer.from(res.content, 'base64').toString('utf8').split('\n')
const ctx = Number(ctxN) || 0
const re = new RegExp(pattern, 'i')
const hits = []
lines.forEach((l, i) => {
  if (re.test(l)) hits.push(i)
})
if (!hits.length) {
  console.log(`（无匹配：${path}）`)
  process.exit(0)
}
// 合并相邻命中区间
const ranges = []
for (const h of hits) {
  const start = Math.max(0, h - ctx)
  const end = Math.min(lines.length - 1, h + ctx)
  const last = ranges[ranges.length - 1]
  if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
  else ranges.push([start, end])
}
for (const [s, e] of ranges) {
  console.log(`--- 行 ${s + 1}-${e + 1} ---`)
  for (let i = s; i <= e; i++) console.log(`${String(i + 1).padStart(5)}| ${lines[i]}`)
}
console.log(`\n共 ${hits.length} 处命中`)

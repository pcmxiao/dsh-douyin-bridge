/**
 * tools/gh-file.mjs —— 用 gh api 取仓库里的文件（绕过 web_fetch 额度限制）
 * 用法：node tools/gh-file.mjs <owner/repo> <path> [行数]
 */
import { execFileSync } from 'node:child_process'

const [repo, path, lines] = process.argv.slice(2)
if (!repo || !path) {
  console.error('用法: node tools/gh-file.mjs <owner/repo> <path> [maxLines]')
  process.exit(1)
}
const res = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/contents/${path}`], {
  encoding: 'utf8',
  maxBuffer: 128 * 1024 * 1024,
}))
const text = Buffer.from(res.content, 'base64').toString('utf8')
const n = Number(lines) || 0
console.log(n ? text.split('\n').slice(0, n).join('\n') : text)

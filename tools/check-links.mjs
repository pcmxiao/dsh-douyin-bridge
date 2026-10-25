/**
 * tools/check-links.mjs —— 检查 Markdown 里的相对链接和锚点有没有断
 * ============================================================================
 * 只查仓库内部的 `.md` 相对链接和 `#anchor`，外链不查（网络不稳定，误报太多）。
 *
 * 用法：node tools/check-links.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let bad = 0
let checked = 0

/** GitHub 的锚点规则：小写、去标点、空格转连字符 */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[`*_~[\]()#]/g, '')
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

/** 收集某个 md 文件里所有可锚定的标题 */
function anchorsOf(file) {
  const src = readFileSync(file, 'utf8')
  const set = new Set()
  const seen = new Map()
  for (const line of src.split(/\r?\n/)) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    let slug = slugify(m[1])
    const n = (seen.get(slug) ?? 0) + 1
    seen.set(slug, n)
    if (n > 1) slug = `${slug}-${n - 1}`
    set.add(slug)
  }
  return set
}

const files = []
for (const name of readdirSync(ROOT)) {
  if (!name.endsWith('.md')) continue
  files.push(join(ROOT, name))
}

for (const file of files) {
  const src = readFileSync(file, 'utf8')
  const rel = relative(ROOT, file)
  for (const m of src.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)) {
    const target = m[2].trim()
    if (/^(https?:|mailto:)/.test(target)) continue
    checked++
    const [pathPart, anchor] = target.split('#')
    const targetFile = pathPart ? resolve(dirname(file), pathPart) : file
    if (pathPart && !existsSync(targetFile)) {
      console.log(`  ✘ ${rel}: 链接目标不存在 → ${target}`)
      bad++
      continue
    }
    if (anchor) {
      const anchors = anchorsOf(targetFile)
      if (!anchors.has(anchor)) {
        console.log(`  ✘ ${rel}: 锚点找不到 → #${anchor}（在 ${relative(ROOT, targetFile)}）`)
        bad++
      }
    }
  }
}

console.log(bad
  ? `\n✘ ${bad} 个断链（共检查 ${checked} 个内部链接）`
  : `✔ ${checked} 个内部链接全部有效`)
process.exit(bad ? 1 : 0)

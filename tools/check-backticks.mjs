/**
 * 检查 douyin.mjs 里所有「页面 JS 模板」内部有没有裸反引号。
 *
 * 为什么要这个工具：这些模板用 `browser.eval(\`...\`)` 包起来，
 * 里面一旦出现反引号（哪怕是注释里的），模板就被提前截断 ——
 * 报错是 `SyntaxError: missing ) after argument list`，
 * 行号指向模板开头，很难看出真实位置。这个脚本直接列出所有可疑行。
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2] || 'lib/douyin.mjs'
const src = readFileSync(file, 'utf8')
const lines = src.split('\n')

let inTemplate = false
let startLine = 0
let bad = 0

for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  // 统计这一行的反引号数量（不算转义的）
  const ticks = (line.match(/(?<!\\)`/g) || []).length

  if (!inTemplate && ticks > 0) {
    // 模板开始
    inTemplate = ticks % 2 === 1
    if (inTemplate) startLine = i + 1
    continue
  }

  if (inTemplate) {
    if (ticks > 0) {
      // 模板结束（或者内部又有反引号）
      if (ticks % 2 === 1) inTemplate = false
      else {
        console.log(`✘ 第 ${i + 1} 行：模板（从第 ${startLine} 行开始）内部出现反引号`)
        console.log(`   ${line.trim()}`)
        bad++
      }
    }
  }
}

console.log(bad === 0 ? '✔ 没有裸反引号' : `\n共 ${bad} 处可疑`)
process.exit(bad ? 1 : 0)

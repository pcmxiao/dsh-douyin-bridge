/**
 * 读一个 DSH 会话的事件日志（zstd 压缩的 jsonl）。
 *
 * DSH 把会话存成 `<DSH_HOME>/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd`。
 * Node 22+ 有内置 zstd，但 jsonl 也可能是**每行一个 zstd 帧**，所以先整体解压再按行切。
 *
 * 用法：
 *   node tools/session-log.mjs "douyin-___-9975c5de"
 *   node tools/session-log.mjs "douyin-___-9975c5de" --json
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const root = join(home, 'sessions')
const want = process.argv[2]
const asJson = process.argv.includes('--json')

if (!want) {
  // 没给 id 就列出所有 douyin-* 会话
  for (const ws of readdirSync(root)) {
    const dir = join(root, ws)
    let subs = []
    try { subs = readdirSync(dir) } catch { continue }
    for (const s of subs) {
      if (s.startsWith('douyin-')) console.log(`${s}   (${ws})`)
    }
  }
  process.exit(0)
}

// 找这个会话的目录
let dir = ''
for (const ws of readdirSync(root)) {
  const d = join(root, ws, want)
  if (existsSync(d)) { dir = d; break }
}
if (!dir) { console.error(`找不到会话 ${want}`); process.exit(1) }

const file = join(dir, 'session.v4.jsonl.zstd')
if (!existsSync(file)) { console.error(`没有 ${file}`); process.exit(1) }

const raw = readFileSync(file)
let text
try {
  text = zstdDecompressSync(raw).toString('utf8')
} catch (e) {
  // 每行一个独立帧的格式：逐行解
  const lines = []
  for (const chunk of raw.toString('latin1').split('\n')) {
    if (!chunk.trim()) continue
    try { lines.push(zstdDecompressSync(Buffer.from(chunk, 'latin1')).toString('utf8')) } catch { /* 跳过 */ }
  }
  text = lines.join('\n')
  if (!text) { console.error(`解压失败：${e?.message || e}`); process.exit(1) }
}

const events = []
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  try { events.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
}

if (asJson) { console.log(JSON.stringify(events, null, 2)); process.exit(0) }

for (const ev of events) {
  const t = ev.type
  if (t === 'user/message') {
    const txt = (ev.data?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
    console.log(`\n[用户] ${txt.slice(0, 300)}`)
  } else if (t === 'assistant/message') {
    const txt = (ev.data?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
    if (txt) console.log(`[助手] ${txt.slice(0, 400)}`)
    const tools = (ev.data?.message?.content ?? []).filter((b) => b.type === 'tool-call').map((b) => b.name)
    if (tools.length) console.log(`      工具: ${tools.join(', ')}`)
  } else if (t === 'turn/end') {
    console.log(`[回合结束] reason=${ev.data?.reason}`)
  } else if (t === 'session/meta') {
    console.log(`[会话] ${JSON.stringify(ev.data).slice(0, 200)}`)
  }
}

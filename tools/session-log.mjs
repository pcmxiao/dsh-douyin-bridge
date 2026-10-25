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

/**
 * 解压 session 文件。
 *
 * 🔴 DSH 的 `session.v4.jsonl.zstd` 是**多帧拼接**的：
 *    每追加一批事件就压一个新帧接在后面。
 *    而 `zstdDecompressSync(buf)` 只解**第一帧**就停 ——
 *    结果是「文件 120KB，解出来只有一行 session 头」，
 *    看起来像「会话是空的」，实际是解压没解完。
 *
 *    正确做法：逐帧解，把每一帧的输出接起来。
 *    判断一帧结束：zstd 帧头里带 content size 的可以从
 *    `ZSTD_getFrameContentSize` 得知；Node 没暴露这个 API，
 *    所以用「从当前偏移尝试解，成功就前进，失败就报错」的笨办法。
 */
function decompressAll(buf) {
  const parts = []
  let offset = 0
  let guard = 0

  while (offset < buf.length && guard++ < 10000) {
    const slice = buf.subarray(offset)
    let out = null
    let consumed = 0

    // Node 的 zstdDecompressSync 不告诉我们消费了多少字节，
    // 所以用「逐步缩短」的办法找这一帧的边界：先整段解，再二分找最小可解长度。
    // 实际上更简单：一帧解出来的结果一定不依赖后面的帧，
    // 所以直接整段解一次拿到内容，然后用「解出来的内容长度」反推不了偏移。
    //
    // ⇒ 换个思路：**扫描 zstd 魔数**（0x28 0xB5 0x2F 0xFD）作为帧边界。
    //   每一帧都以这个 4 字节魔数开头，且不会出现在压缩数据内部
    //   （zstd 用 FSE/Huffman，魔数碰撞概率极低，且帧头还有校验）。
    const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    let next = -1
    for (let i = offset + 4; i <= slice.length - 4; i++) {
      if (slice[i] === 0x28 && slice[i + 1] === 0xb5 && slice[i + 2] === 0x2f && slice[i + 3] === 0xfd) {
        next = i
        break
      }
    }

    const end = next === -1 ? slice.length : next
    try {
      out = zstdDecompressSync(slice.subarray(0, end))
      consumed = end
    } catch {
      // 这一帧解不开：可能魔数误判，往后挪一个字节重试
      offset += 1
      continue
    }

    if (out && out.length) parts.push(out)
    offset += consumed
  }

  return Buffer.concat(parts)
}

let text
try {
  text = decompressAll(raw).toString('utf8')
  if (!text.trim()) throw new Error('解出来是空的')
} catch (e) {
  // 兜底：整体解一次（单帧的情况）
  try {
    text = zstdDecompressSync(raw).toString('utf8')
  } catch (e2) {
    console.error(`解压失败：${e2?.message || e2}`)
    process.exit(1)
  }
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

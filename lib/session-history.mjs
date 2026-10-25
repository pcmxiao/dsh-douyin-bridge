/**
 * lib/session-history.mjs —— 从 DSH 会话日志里读抖音私信历史
 * ============================================================================
 * 为什么需要这层：
 *
 * 抖音网页版是**虚拟列表**，DOM 里只有最近一屏（约 20 条）。
 * 但**所有注入过的消息都已经落在 DSH 的 session 日志里了** ——
 * 那里才是完整的、结构化的、不受抖音改版影响的历史。
 *
 * 所以「读历史」不该去抖音翻，应该读 DSH：
 *
 *   ~/.dsh/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd
 *     ├ session                     会话头
 *     ├ agent/inbox/spliced         注入的抖音私信（data.inserted[]）
 *     ├ user/message                同上（另一条路径）
 *     ├ assistant/message           AI 的回复
 *     └ tool/call, tool/result      工具调用
 *
 * 🔴 关键技术点：这个文件是**多帧 zstd 拼接**的。
 *    每追加一批事件就压一个新帧接在后面，而 `zstdDecompressSync(buf)`
 *    只解**第一帧**就停 —— 表现是「文件 120KB，解出来只有一行会话头」，
 *    看起来像会话是空的。必须逐帧解再拼起来（见 decompressAll）。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

/** DSH 家目录 */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 解压多帧拼接的 zstd。
 *
 * DSH 的 session 文件是「一帧一批事件」的形式，整体解只出第一帧。
 * 这里按 zstd 魔数（28 B5 2F FD）扫描帧边界，逐帧解再拼。
 *
 * @param {Buffer} buf
 * @returns {Buffer}
 */
export function decompressAll(buf) {
  const parts = []
  let offset = 0
  let guard = 0

  while (offset < buf.length && guard++ < 100000) {
    // 从 offset 之后找下一个魔数 = 这一帧的结尾
    let next = -1
    for (let i = offset + 4; i <= buf.length - 4; i++) {
      if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1]
        && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) {
        next = i
        break
      }
    }
    const end = next === -1 ? buf.length : next

    try {
      const out = zstdDecompressSync(buf.subarray(offset, end))
      if (out.length) parts.push(out)
      offset = end
    } catch {
      // 魔数误判（压缩数据里偶然出现同样的 4 字节）：往后挪一个字节重试
      offset += 1
    }
  }

  return Buffer.concat(parts)
}

/** 找某个 sessionId 的目录（workspace 名不确定，要遍历） */
export function findSessionDir(sessionId) {
  const root = join(dshHome(), 'sessions')
  if (!existsSync(root)) return ''
  try {
    for (const ws of readdirSync(root)) {
      const d = join(root, ws, sessionId)
      if (existsSync(d)) return d
    }
  } catch { /* 忽略 */ }
  return ''
}

/**
 * 读一个会话的全部事件。
 *
 * @param {string} sessionId
 * @returns {{ok:boolean, events:Array, error?:string}}
 */
export function readSessionEvents(sessionId) {
  const dir = findSessionDir(sessionId)
  if (!dir) return { ok: false, events: [], error: `找不到会话 ${sessionId}` }

  const file = join(dir, 'session.v4.jsonl.zstd')
  if (!existsSync(file)) return { ok: false, events: [], error: `没有 ${file}` }

  let text
  try {
    const raw = readFileSync(file)
    text = decompressAll(raw).toString('utf8')
    if (!text.trim()) {
      // 兜底：单帧
      text = zstdDecompressSync(raw).toString('utf8')
    }
  } catch (e) {
    return { ok: false, events: [], error: `解压失败：${e?.message || e}` }
  }

  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
  }
  return { ok: true, events }
}

/** 从消息内容里取纯文本 */
function textOf(content) {
  return (content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

/** 注入的私信长这样：【抖音私信 · 好友名】\n正文 */
const INJECT_RE = /^【抖音私信 · (.+?)】\n([\s\S]*)$/

/**
 * 从会话事件里抽出「抖音私信对话」。
 *
 * 返回按时间排序的 [{role:'peer'|'me', text, time}]。
 *   · `peer` = 好友发来的（注入的 user 消息）
 *   · `me`   = AI 回出去的（assistant 文本 + douyin_dm_send 的内容）
 *
 * @param {Array} events readSessionEvents 的 events
 * @returns {Array<{role:string, text:string, time:number, source:string}>}
 */
export function extractDialog(events) {
  const out = []

  for (const ev of events) {
    const t = ev.type

    // ① 注入的抖音私信
    if (t === 'agent/inbox/spliced' || t === 'user/message') {
      const list = t === 'agent/inbox/spliced'
        ? (ev.data?.inserted ?? [])
        : (ev.data?.message ? [ev.data.message] : [])
      for (const m of list) {
        const txt = textOf(m?.content)
        const hit = INJECT_RE.exec(txt)
        if (!hit) continue
        out.push({
          role: 'peer',
          peer: hit[1],
          text: hit[2].trim(),
          time: ev.time || 0,
          source: 'injected',
        })
      }
      continue
    }

    // ② AI 的回复（文本部分）
    if (t === 'assistant/message') {
      const txt = textOf(ev.data?.message?.content).trim()
      if (!txt) continue
      out.push({ role: 'me', text: txt, time: ev.time || 0, source: 'assistant' })
      continue
    }
  }

  out.sort((a, b) => a.time - b.time)

  // 🔴 去重：同一条内容、同一秒内出现多次，只留一条。
  //
  //    来源有两处：
  //      · 桥接重复注入（同一轮轮询把同一条消息注了两次）
  //      · `assistant/message` 在同一步里可能发多条（工具调用前后的文本）
  //    完全一样的「谁 + 内容 + 秒级时间」重复对人没意义，去掉。
  const seen = new Set()
  return out.filter((m) => {
    const sec = Math.floor((m.time || 0) / 1000)
    const k = `${m.role}|${sec}|${m.text}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * 从一个会话里读出「跟某个好友的完整对话历史」。
 *
 * @param {string} sessionId
 * @param {string} [peer] 只留这个好友的（空 = 全留）
 * @param {number} [limit] 最多返回多少条（取最后 N 条）
 */
export function readDialog(sessionId, peer = '', limit = 200) {
  const r = readSessionEvents(sessionId)
  if (!r.ok) return { ok: false, messages: [], error: r.error }

  let msgs = extractDialog(r.events)
  if (peer) msgs = msgs.filter((m) => !m.peer || m.peer === peer)

  return {
    ok: true,
    total: msgs.length,
    messages: limit > 0 ? msgs.slice(-limit) : msgs,
  }
}

/** 列出所有 douyin-* 会话（含事件数，方便挑） */
export function listBridgeSessions() {
  const root = join(dshHome(), 'sessions')
  if (!existsSync(root)) return []
  const out = []
  try {
    for (const ws of readdirSync(root)) {
      const wsDir = join(root, ws)
      let subs = []
      try { subs = readdirSync(wsDir) } catch { continue }
      for (const sid of subs) {
        if (!sid.startsWith('douyin-')) continue
        const f = join(wsDir, sid, 'session.v4.jsonl.zstd')
        const size = existsSync(f) ? readFileSync(f).length : 0
        out.push({ sessionId: sid, workspace: ws, bytes: size })
      }
    }
  } catch { /* 忽略 */ }
  return out.sort((a, b) => b.bytes - a.bytes)
}

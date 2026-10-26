/**
 * tools/watch-inject.mjs —— 盯着注入，看新消息有没有进 DSH
 * ============================================================================
 * 桥接现在的状态：轮询不报错、apiMessages 有 50 条、会话映射已建立，
 * 但 injected=0（历史消息都被标成基线了，这是设计如此）。
 *
 * 这个脚本轮询 status，一旦 injected 涨了就打印出来。
 * 用法：node tools/watch-inject.mjs [秒数]
 */
import { getJson } from './dsh-rpc.mjs'

const secs = Number(process.argv[2]) || 120
const log = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`)

let last = null
const deadline = Date.now() + secs * 1000

while (Date.now() < deadline) {
  try {
    // getJson 返回的是 HTTP 层结构：{ status: 200, body: { ok, status: {...} } }
    const raw = await getJson('/dsh-douyin-bridge/status')
    const s = raw?.body?.status || raw?.status?.status || raw?.body || {}
    const cur = { injected: s.injected, sent: s.sent, polls: s.polls, api: s.apiMessages, err: s.lastError || '' }
    if (!last || cur.injected !== last.injected || cur.api !== last.api || cur.polls !== last.polls) {
      log(`polls=${cur.polls} injected=${cur.injected} sent=${cur.sent} api=${cur.api}${cur.err ? ' ERR=' + cur.err.slice(0, 60) : ''}`)
    }
    if (last && cur.injected > last.injected) {
      log(`★★★ 注入了 ${cur.injected - last.injected} 条新消息！`)
    }
    last = cur
  } catch (e) {
    log(`status 读取失败：${e.message}`)
  }
  await new Promise((r) => setTimeout(r, 3000))
}

log(`\n结束。最后状态：${JSON.stringify(last)}`)
process.exit(0)

/**
 * tools/probe-raw-content.mjs —— dump raw content JSON of private messages
 * ============================================================================
 * Goals:
 *   (1) confirm how message-type enum numbers map to my own `kind`
 *   (2) find the content shape of a voice message (VOICE=17 / IM_ENCRYPT_VOICE=109)
 *   (3) see the content format of image/emoji so I can reuse the field names
 *
 * How: reload (drops douyin's in-memory cache) -> open conversation ->
 *       drain the protobuf -> print the raw JSON of field #8 per message.
 *
 * Usage: node tools/probe-raw-content.mjs <peer-name>
 */
import { getBrowser } from '../lib/browser.mjs'
import { installHook, drain, triggerFetch } from '../lib/douyin-api.mjs'
import { ensurePanel, enterChat } from '../lib/douyin.mjs'
import { parseTree, getString, getInt, all } from '../lib/pb.mjs'
import { loadConfig } from '../lib/state.mjs'

const cfg = loadConfig()
const log = (m) => console.log(m)
const b = await getBrowser({ reuse: true, port: cfg.browserPort, log })
const peer = process.argv[2] || ''
if (!peer) { log('usage: node tools/probe-raw-content.mjs <peer-name>'); process.exit(1) }

await installHook(b)

log('opening conversation...')
// 带 cache-buster，保证是**新文档**（同 URL 的 Page.navigate 可能被浏览器当原地导航）
await b.goto(`https://www.douyin.com/jingxuan?_probe=${Date.now()}`, { settleMs: 10000 })
const ready = await b.eval(`Boolean(window.__dyIM && window.__dyIM.drain)`).catch(() => false)
log(`  hook in page: ${ready}`)
await new Promise(r => setTimeout(r, 4000))
const st = await ensurePanel(b)
log(`  panel=${JSON.stringify(st)}`)

// IM 初始化请求（get_message_by_init / get_user_message）只在面板被**打开**时发。
// 页面 restore 了上次的会话 ⇒ 面板一直开着 ⇒ 永远不发请求。
// ⇒ 强制「关一次、再开一次」。
const clickEntry = async () => {
  const p = await b.eval(`(() => {
    const el = document.querySelector('[data-e2e="im-entry"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (!p) return 'no-entry'
  for (const type of ['mousePressed', 'mouseReleased']) {
    await b.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 }, b.sessionId)
  }
  return 'clicked'
}
log('  toggling panel to force IM init...')
await clickEntry()
await new Promise(r => setTimeout(r, 2500))
await clickEntry()
await new Promise(r => setTimeout(r, 5000))

// 抖音只在「第一次进某个会话」时请求 get_by_conversation。
// 页面 reload 后它会把上次打开的会话从 localStorage 恢复回来 —— 于是又是内存缓存，不发请求。
// ⇒ 绕法：先切到**别的**会话，再切回来。
log('  switching conversation to force a fetch...')
const convs = await b.eval(`(() => {
  const items = [...document.querySelectorAll('[data-e2e="conversation-item"]')]
  return items.map((el, i) => ({ i, txt: (el.innerText || '').trim().slice(0, 20) }))
})()`)
log(`  会话列表: ${JSON.stringify(convs)}`)
if (convs?.length > 1) {
  await b.eval(`(() => {
    const items = [...document.querySelectorAll('[data-e2e="conversation-item"]')]
    const other = items.find((el) => !(el.innerText || '').includes(${JSON.stringify(peer)}))
    if (!other) return 'no-other'
    other.click()
    return 'switched'
  })()`).then(r => log('  ' + r))
  await new Promise(r => setTimeout(r, 4000))
}
await b.eval(`(() => {
  const el = [...document.querySelectorAll('[data-e2e="conversation-item"]')]
    .find(x => (x.innerText || '').includes(${JSON.stringify(peer)}))
  if (!el) return 'no-item'
  el.click()
  return 'back'
})()`).then(r => log('  ' + r))
await new Promise(r => setTimeout(r, 6000))

const list = await drain(b)
log(`drained ${list.length} responses`)
for (const it of list) log(`  url: ${String(it.url).split('?')[0]}  kind=${it.kind}  bytes=${it.b64 ? it.b64.length : 0}`)

for (const item of list) {
  const url = item.url || ''
  if (!/get_by_conversation|get_user_message|get_message_by_init/.test(url)) continue
  const raw = item.b64 ? Buffer.from(item.b64, 'base64') : null
  if (!raw || !raw.length) { log('  (no b64)'); continue }
  log(`\n==== ${url} (${raw.length} bytes) ====`)

  const tree = parseTree(raw)
  const body = tree.find((n) => n.field === 6 && n.kind === 'message')
  if (!body) { log('  no #6 body'); continue }
  const listHolder = body.children.find(
    (n) => n.kind === 'message' && n.children.some((c) => c.field === 1 && c.kind === 'message'),
  )
  const listNode = listHolder || body
  const items = all(listNode.children, 1).filter((n) => n.kind === 'message')
  log(`  ${items.length} messages`)

  for (const it of items) {
    const c = it.children
    const kind = getInt(c, 6) ?? 0
    const seq = getInt(c, 17) ?? 0
    const j = getString(c, 8)
    log(`\n  -- kind=${kind} seq=${seq} --`)
    if (j) {
      log(`  content(#8) = ${j.slice(0, 1500)}`)
    } else {
      log('  content(#8) empty')
      for (const n of c) {
        if (n.kind === 'string' && n.value.length) log(`    #${n.field} str "${n.value.slice(0, 120)}"`)
        if (n.kind === 'message' && n.field === 9) {
          const k = getString(n.children, 1)
          const v = getString(n.children, 2)
          if (k || v) log(`    #9 attr ${k} = ${String(v).slice(0, 120)}`)
        }
      }
    }
  }
}

process.exit(0)

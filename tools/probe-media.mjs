/**
 * tools/probe-media.mjs —— 探测抖音私信面板的「非文本消息」结构
 * ============================================================================
 * 目的：搞清楚三件事
 *   ① 消息气泡里图片 / 语音 / 表情长什么样（DOM 结构 + data-e2e 锚点）
 *   ② 工具栏上「表情」「图片」按钮怎么点，有没有 input[type=file]
 *   ③ 页面上到底有哪些 data-e2e（抖音自己的测试锚点，最稳）
 *
 * 用法：
 *   node tools/probe-media.mjs <好友名>
 *
 * ⚠️ 跑之前先停桥接（POST /dsh-douyin-bridge/stop），否则两边抢同一个页面。
 */
import { getBrowser } from '../lib/browser.mjs'
import { ensurePanel, enterChat } from '../lib/douyin.mjs'
import { loadConfig } from '../lib/state.mjs'

const cfg = loadConfig()
const peer = process.argv[2] || ''
const log = (m) => console.log(m)

const b = await getBrowser({ reuse: true, port: cfg.browserPort, log })
log('✔ 浏览器已连上')

const st = await ensurePanel(b)
log(`面板: ${JSON.stringify({ panelOpen: st.panelOpen, inChat: st.inChat, convCount: st.convCount, vw: st.vw, vh: st.vh, error: st.error || '' })}`)

if (!st.inChat) {
  const ok = await enterChat(b, peer)
  log(`进会话「${peer}」: ${ok}`)
  if (!ok) { log('✘ 进不去'); process.exit(1) }
} else {
  log('已经在聊天界面')
}

// ── ① 页面上所有 data-e2e ─────────────────────────────────────────
const e2e = await b.eval(`(() => {
  const out = []
  for (const el of document.querySelectorAll('[data-e2e]')) {
    const r = el.getBoundingClientRect()
    out.push({
      e2e: el.getAttribute('data-e2e'),
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').slice(0, 70),
      w: Math.round(r.width), h: Math.round(r.height),
      txt: (el.innerText || '').trim().slice(0, 24),
    })
  }
  return out
})()`)
log('\n── 页面上的 data-e2e 锚点')
const seenE2e = new Map()
for (const e of e2e || []) {
  const k = e.e2e
  if (!seenE2e.has(k)) seenE2e.set(k, { ...e, n: 0 })
  seenE2e.get(k).n++
}
for (const [k, e] of seenE2e) {
  log(`  ${String(k).padEnd(28)} ×${String(e.n).padEnd(3)} <${e.tag}> ${e.w}×${e.h}  ${e.cls}`)
}

// ── ② 文件输入框 ─────────────────────────────────────────────────
const files = await b.eval(`(() => {
  return [...document.querySelectorAll('input[type=file]')].map((el) => {
    const r = el.getBoundingClientRect()
    return {
      accept: el.accept || '',
      multiple: el.multiple,
      cls: String(el.className || '').slice(0, 60),
      visible: r.width > 0 && r.height > 0,
      parentCls: String(el.parentElement?.className || '').slice(0, 60),
      grandparentCls: String(el.parentElement?.parentElement?.className || '').slice(0, 60),
    }
  })
})()`)
log('\n── input[type=file]')
log(files?.length ? JSON.stringify(files, null, 2) : '  （没有）')

// ── ③ 工具栏按钮 ─────────────────────────────────────────────────
const toolbar = await b.eval(`(() => {
  const input = document.querySelector('[data-e2e="msg-input"]')
  const root = input ? (input.closest('[class*="footer"]') || input.parentElement) : null
  const scope = root || document.body
  const out = []
  for (const el of scope.querySelectorAll('button,[role="button"],svg,img')) {
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) continue
    out.push({
      tag: el.tagName.toLowerCase(),
      e2e: el.getAttribute('data-e2e') || '',
      title: el.getAttribute('title') || '',
      aria: el.getAttribute('aria-label') || '',
      cls: String(el.className?.baseVal ?? el.className ?? '').slice(0, 60),
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.left), y: Math.round(r.top),
    })
  }
  return { hasRoot: Boolean(root), rootCls: String(root?.className || ''), items: out }
})()`)
log('\n── 工具栏')
log(`  根容器: ${toolbar?.rootCls || '(无，用 body)'}  子元素 ${toolbar?.items?.length ?? 0} 个`)
for (const it of (toolbar?.items || []).slice(0, 40)) {
  log(`   <${it.tag}> e2e=${it.e2e || '-'} title=${it.title || '-'} aria=${it.aria || '-'} ${it.w}×${it.h} @${it.x},${it.y}  ${it.cls}`)
}

// ── ④ 消息气泡内部结构 ───────────────────────────────────────────
const bubbles = await b.eval(`(() => {
  const FIND = (() => {
    const CHAINS = {
      messageBox: ['[data-e2e="message-item"]','div[class*="messageMessageBox"][class*="messageBox"]','div[class*="messageMessageBox"]'],
    }
    const all = (k) => { for (const s of CHAINS[k]) { const f=[...document.querySelectorAll(s)]; if (f.length) return f } return [] }
    return { all }
  })()
  const boxes = FIND.all('messageBox').filter((el) => {
    const r = el.getBoundingClientRect()
    return r.width > 100 && r.height > 20
  })
  const dump = (el, depth) => {
    if (depth > 4) return null
    const r = el.getBoundingClientRect()
    const node = {
      tag: el.tagName.toLowerCase(),
      e2e: el.getAttribute('data-e2e') || '',
      cls: String(el.className || '').slice(0, 55),
      w: Math.round(r.width), h: Math.round(r.height),
      txt: (el.innerText || '').trim().slice(0, 30),
      src: (el.getAttribute && el.getAttribute('src') || '').slice(0, 90),
    }
    const kids = [...el.children]
    if (kids.length) node.k = kids.map((c) => dump(c, depth + 1)).filter(Boolean)
    return node
  }
  return boxes.slice(-8).map((b) => dump(b, 0))
})()`)
log('\n── 最近的消息气泡结构')
log(JSON.stringify(bubbles, null, 1))

// ── ⑤ 页面里所有 <img>（图片消息的线索）───────────────────────────
const imgs = await b.eval(`(() => {
  const out = []
  for (const el of document.querySelectorAll('img')) {
    const r = el.getBoundingClientRect()
    if (r.width < 20 || r.height < 20) continue
    out.push({
      src: (el.getAttribute('src') || '').slice(0, 140),
      cls: String(el.className || '').slice(0, 55),
      alt: (el.getAttribute('alt') || '').slice(0, 30),
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.left), y: Math.round(r.top),
    })
  }
  return out.slice(0, 25)
})()`)
log('\n── 可见 <img>')
for (const i of imgs || []) log(`   ${i.w}×${i.h} @${i.x},${i.y}  ${i.src}\n        cls=${i.cls} alt=${i.alt}`)

process.exit(0)

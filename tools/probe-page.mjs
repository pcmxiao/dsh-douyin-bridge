/**
 * tools/probe-page.mjs —— 看页面当前到底什么状态（通用诊断）
 * 用法：node tools/probe-page.mjs
 */
import { getBrowser } from '../lib/browser.mjs'
import { loadConfig } from '../lib/state.mjs'

const cfg = loadConfig()
const log = (m) => console.log(m)
const b = await getBrowser({ reuse: true, port: cfg.browserPort, log })

const info = await b.eval(`(() => ({
  href: location.href,
  title: document.title,
  ready: document.readyState,
  bodyLen: document.body ? document.body.innerText.length : -1,
  bodyHead: document.body ? document.body.innerText.slice(0, 300) : '',
  imEntry: !!document.querySelector('[data-e2e="im-entry"]'),
  imDialog: document.querySelectorAll('[data-e2e="im-dialog"]').length,
  convItem: document.querySelectorAll('[data-e2e="conversation-item"]').length,
  msgInput: !!document.querySelector('[data-e2e="msg-input"]'),
  e2eAll: [...new Set([...document.querySelectorAll('[data-e2e]')].map(e => e.getAttribute('data-e2e')))].slice(0, 40),
  vw: innerWidth, vh: innerHeight,
  sw: screen.availWidth, sh: screen.availHeight,
}))()`)
log(JSON.stringify(info, null, 1))

// 顺便看看页面上有哪些可点的导航
const nav = await b.eval(`(() => [...document.querySelectorAll('[data-e2e]')].slice(0, 60).map(e => {
  const r = e.getBoundingClientRect()
  return { e2e: e.getAttribute('data-e2e'), tag: e.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height),
           x: Math.round(r.left), y: Math.round(r.top), txt: (e.innerText||'').trim().slice(0,20) }
}))()`)
log('\n── data-e2e 清单')
for (const n of nav || []) log(`  ${String(n.e2e).padEnd(26)} <${n.tag}> ${n.w}×${n.h} @${n.x},${n.y} ${n.txt}`)

process.exit(0)

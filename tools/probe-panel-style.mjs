/**
 * tools/probe-panel-style.mjs —— 查 im-dialog / conversation-item 为什么是 0×0
 * 用法：node tools/probe-panel-style.mjs
 */
import { getBrowser } from '../lib/browser.mjs'
import { loadConfig } from '../lib/state.mjs'

const cfg = loadConfig()
const log = (m) => console.log(m)
const b = await getBrowser({ reuse: true, port: cfg.browserPort, log })

const out = await b.eval(`(() => {
  const dump = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return { sel, missing: true }
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    const p = el.parentElement
    const ps = p ? getComputedStyle(p) : null
    const pr = p ? p.getBoundingClientRect() : null
    return {
      sel,
      rect: [Math.round(r.width), Math.round(r.height), Math.round(r.left), Math.round(r.top)],
      style: {
        display: s.display, position: s.position, width: s.width, height: s.height,
        overflow: s.overflow, transform: s.transform, opacity: s.opacity,
        visibility: s.visibility, maxWidth: s.maxWidth, minWidth: s.minWidth,
        left: s.left, right: s.right, top: s.top,
      },
      parent: p ? {
        tag: p.tagName.toLowerCase(),
        cls: String(p.className || '').slice(0, 60),
        rect: pr ? [Math.round(pr.width), Math.round(pr.height), Math.round(pr.left), Math.round(pr.top)] : null,
        style: ps ? { display: ps.display, width: ps.width, height: ps.height, overflow: ps.overflow, transform: ps.transform } : null,
      } : null,
      // 往上再找两层，看是哪一层塌了
      chain: (() => {
        const c = []
        let n = el
        for (let i = 0; i < 5 && n; i++) {
          const rr = n.getBoundingClientRect()
          const ss = getComputedStyle(n)
          c.push({
            tag: n.tagName.toLowerCase(),
            cls: String(n.className || '').slice(0, 50),
            rect: [Math.round(rr.width), Math.round(rr.height)],
            display: ss.display, position: ss.position, width: ss.width, height: ss.height,
            overflow: ss.overflow, transform: ss.transform.slice(0, 30),
          })
          n = n.parentElement
        }
        return c
      })(),
    }
  }
  return {
    imDialog: dump('[data-e2e="im-dialog"]'),
    convItem: dump('[data-e2e="conversation-item"]'),
    // 页面上有没有别的容器装了私信面板
    altPanel: [...document.querySelectorAll('div')].filter(d => {
      const r = d.getBoundingClientRect()
      return r.width > 200 && r.height > 300 && /<好友名>/.test(d.innerText || '')
    }).slice(0, 5).map(d => {
      const r = d.getBoundingClientRect()
      return { cls: String(d.className||'').slice(0,70), rect: [Math.round(r.width), Math.round(r.height), Math.round(r.left), Math.round(r.top)] }
    }),
    // 屏幕信息
    screen: { w: screen.width, h: screen.height, aw: screen.availWidth, ah: screen.availHeight, dpr: devicePixelRatio },
  }
})()`)
log(JSON.stringify(out, null, 1))
process.exit(0)

/**
 * tools/probe-comment.mjs —— map the comment UI on a douyin video page
 * ============================================================================
 * Douyin's video page is flaky (risk control sometimes redirects to the feed),
 * so: try several video ids, poll until the comment area shows up, then dump
 * every element whose class name mentions "comment" so we can derive the
 * real selectors instead of guessing.
 *
 * Usage: node tools/probe-comment.mjs [keyword]
 *        node tools/probe-comment.mjs --vid <id>
 */
import { getBrowser } from '../lib/browser.mjs'
import { search } from '../lib/douyin.mjs'
import { loadConfig } from '../lib/state.mjs'

const cfg = loadConfig()
const log = (m) => console.log(m)
const b = await getBrowser({ reuse: true, port: cfg.browserPort, log })

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ── 1. 拿到候选视频 ────────────────────────────────────────────
let ids = []
const arg = process.argv[2] || ''
if (arg === '--vid') {
  ids = [process.argv[3] || '']
} else {
  log(`searching "${arg || 'cat'}" ...`)
  const vids = await search({ browser: b, keyword: arg || 'cat', limit: 6 })
  ids = (vids || []).map(v => v.id).filter(Boolean)
  log(`  got ${ids.length}: ${ids.join(', ')}`)
}
if (!ids.length) { log('no video id'); process.exit(1) }

// ── 2. 逐个试，轮询等评论区出现 ────────────────────────────────
let opened = null
for (const id of ids.slice(0, 4)) {
  log(`\nopening video ${id} ...`)
  await b.goto(`https://www.douyin.com/video/${id}`, { settleMs: 9000 })
  let ready = null
  for (let i = 0; i < 18; i++) {
    ready = await b.eval(`(() => {
      const url = location.href
      const bodyLen = document.body ? document.body.innerText.length : 0
      const ta = document.querySelector('textarea')
      const commentEls = [...document.querySelectorAll('[class*="omment"], [data-e2e*="comment"]')]
        .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
      return {
        url, bodyLen,
        hasVideo: Boolean(document.querySelector('video')),
        hasTextarea: Boolean(ta),
        taPlaceholder: ta ? (ta.getAttribute('placeholder') || '') : '',
        commentCount: commentEls.length,
        redirected: !/\\/video\\//.test(url),
      }
    })()`)
    if (ready.commentCount > 2 || ready.hasTextarea) break
    if (ready.redirected && i >= 3) { log(`  redirected to ${ready.url}`); break }
    await sleep(1000)
  }
  log(`  ${JSON.stringify(ready)}`)
  if (ready && (ready.commentCount > 2 || ready.hasTextarea)) { opened = { id, ready }; break }
}
if (!opened) { log('\nno video page with comments could be opened'); process.exit(1) }
log(`\nusing video ${opened.id}`)

// ── 3. 把所有 comment 相关元素倒出来 ───────────────────────────
const inv = await b.eval(`(() => {
  const out = []
  const seen = new Set()
  for (const el of document.querySelectorAll('*')) {
    const cls = String(el.className?.baseVal ?? el.className ?? '')
    const e2e = el.getAttribute('data-e2e') || ''
    const tag = el.tagName.toLowerCase()
    if (!/omment/i.test(cls) && !/omment/i.test(e2e) && !/omment/i.test(tag)) continue
    const r = el.getBoundingClientRect()
    const key = tag + '|' + cls + '|' + e2e
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      tag, e2e,
      cls: cls.slice(0, 70),
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.left), y: Math.round(r.top),
      ph: el.getAttribute('placeholder') || '',
      role: el.getAttribute('role') || '',
      txt: (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 40),
      kids: el.children.length,
    })
  }
  return out
})()`)
log(`\n==== comment-ish elements: ${inv?.length ?? 0} ====`)
for (const e of inv || []) {
  log(`  <${e.tag}> ${e.w}x${e.h} @${e.x},${e.y} e2e=${e.e2e || '-'} ph="${e.ph}" kids=${e.kids} txt=${e.txt}`)
  log(`      cls=${e.cls}`)
}

// ── 4. 评论区容器里的一棵子树（用来找输入框/发布按钮）─────────
const tree = await b.eval(`(() => {
  // 找评论区的根：包含 "评论" 两个字且面积最大的容器
  const cands = []
  for (const el of document.querySelectorAll('div,section,aside')) {
    const t = (el.innerText || '')
    if (!/评论/.test(t)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 200 || r.height < 100) continue
    cands.push({ el, r, t })
  }
  cands.sort((a, b) => (a.r.width * a.r.height) - (b.r.width * b.r.height))
  const pick = cands[0]
  if (!pick) return { none: true, tried: cands.length }
  const dump = (el, d) => {
    if (d > 4) return null
    const r = el.getBoundingClientRect()
    const node = {
      tag: el.tagName.toLowerCase(),
      e2e: el.getAttribute('data-e2e') || '',
      cls: String(el.className?.baseVal ?? el.className ?? '').slice(0, 60),
      w: Math.round(r.width), h: Math.round(r.height),
      ph: el.getAttribute('placeholder') || '',
      role: el.getAttribute('role') || '',
      txt: (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 30),
    }
    const kids = [...el.children]
    if (kids.length) node.k = kids.map(c => dump(c, d + 1)).filter(Boolean)
    return node
  }
  return { tried: cands.length, root: dump(pick.el, 0) }
})()`)
log('\n==== comment subtree ====')
log(JSON.stringify(tree, null, 1))

process.exit(0)

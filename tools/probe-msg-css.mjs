/**
 * tools/probe-msg-css.mjs —— list message-item blocks from the CSS files
 * ============================================================================
 * The DOM class names come from CSS modules with camelCase locals
 * (`commonMyImage` + `imgReal` -> `commonMyImageimgReal`), so the *block*
 * names live in the stylesheets, not the JS. Grepping the CSS tells us
 * exactly which message types this web build can render.
 *
 * Usage: node tools/probe-msg-css.mjs
 */
import { getBrowser } from '../lib/browser.mjs'
import { loadConfig } from '../lib/state.mjs'

const cfg = loadConfig()
const log = (m) => console.log(m)
const b = await getBrowser({ reuse: true, port: cfg.browserPort, log })

const css = await b.eval(`(() => {
  const urls = new Set()
  for (const l of document.querySelectorAll('link[rel~="stylesheet"]')) urls.add(l.href)
  for (const e of performance.getEntriesByType('resource')) if (/\\.css(\\?|$)/.test(e.name)) urls.add(e.name)
  return [...urls]
})()`)
log(`css files: ${css?.length ?? 0}`)

const blocks = new Map()
for (const url of css || []) {
  let t
  try {
    const r = await fetch(url)
    if (!r.ok) continue
    t = await r.text()
  } catch { continue }
  for (const m of t.matchAll(/\.MessageItem[A-Za-z0-9_]*/g)) {
    const k = m[0].slice(1)
    if (!blocks.has(k)) blocks.set(k, { n: 0, file: url.split('/').pop().slice(0, 50) })
    blocks.get(k).n++
  }
}

const keys = [...blocks.keys()].sort()
log(`distinct MessageItem* css blocks: ${keys.length}\n`)
// 归一化：把后缀元素名去掉，看有哪些「消息类型」
const types = new Map()
for (const k of keys) {
  const m = /^MessageItem([A-Za-z]+?)(?:[A-Z][a-z]*(?:Box|container|Container)?)?$/.exec(k)
  const t = m ? m[1] : k.replace(/^MessageItem/, '')
  if (!types.has(t)) types.set(t, [])
  types.get(t).push(k)
}
log('--- message-type blocks found ---')
for (const [t, list] of [...types].sort()) {
  log(`  ${t}  (${list.length} blocks)  e.g. ${list.slice(0, 3).join(', ')}`)
}

log('\n--- checks ---')
for (const probe of ['MessageItemAudio', 'MessageItemVoice', 'MessageItemRecord', 'MessageItemComment', 'MessageItemShareComment', 'MessageItemShareAweme', 'MessageItemShareUser', 'MessageItemLocation', 'MessageItemLive', 'MessageItemRedEnvelope', 'MessageItemText', 'MessageItemImage', 'MessageItemEmoji', 'MessageItemVideo', 'MessageItemBigEmoji', 'MessageItemUnsuport', 'MessageItemGroupAnnouncement']) {
  const hit = keys.find(k => k.startsWith(probe))
  log(`  ${hit ? '✔' : '✘'} ${probe}${hit ? '  -> ' + hit : ''}`)
}

process.exit(0)

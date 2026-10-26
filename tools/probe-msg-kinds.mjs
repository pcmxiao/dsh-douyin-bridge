/**
 * tools/probe-msg-kinds.mjs —— list every message-item class the web build ships
 * ============================================================================
 * The enum in client-entry lists ~90 message types, but the web build only
 * ships components for a subset. Whatever has a `MessageItem*` class in the
 * bundle is what we can actually read (and sometimes what we can trigger).
 *
 * Usage: node tools/probe-msg-kinds.mjs
 */
import { getBrowser } from '../lib/browser.mjs'
import { loadConfig } from '../lib/state.mjs'

const cfg = loadConfig()
const log = (m) => console.log(m)
const b = await getBrowser({ reuse: true, port: cfg.browserPort, log })

const scripts = await b.eval(`(() => {
  const urls = new Set()
  for (const s of document.querySelectorAll('script[src]')) urls.add(s.src)
  for (const e of performance.getEntriesByType('resource')) if (/\\.js(\\?|$)/.test(e.name)) urls.add(e.name)
  return [...urls]
})()`)

const found = new Map()
for (const url of scripts || []) {
  let t
  try {
    const r = await fetch(url, { headers: { referer: 'https://www.douyin.com/' } })
    if (!r.ok) continue
    t = Buffer.from(await r.arrayBuffer()).toString('utf8')
  } catch { continue }
  for (const m of t.matchAll(/MessageItem[A-Za-z]*/g)) {
    const k = m[0]
    if (!found.has(k)) found.set(k, { n: 0, file: url.split('/').pop().slice(0, 44) })
    found.get(k).n++
  }
  // 类名是运行时拼的 —— 找「MessageItem + 类型」的拼接处
  for (const m of t.matchAll(/MessageItem["'`+][^"'`]{0,30}/g)) {
    const k = 'PATTERN: ' + m[0]
    if (!found.has(k)) found.set(k, { n: 0, file: url.split('/').pop().slice(0, 44) })
    found.get(k).n++
  }
  for (const m of t.matchAll(/MessageItem\$\{[^}]{0,50}/g)) {
    const k = 'TEMPLATE: ' + m[0]
    if (!found.has(k)) found.set(k, { n: 0, file: url.split('/').pop().slice(0, 44) })
    found.get(k).n++
  }
}

const keys = [...found.keys()].sort()
log(`distinct MessageItem* class names: ${keys.length}\n`)
for (const k of keys) {
  log(`  ${k}   x${found.get(k).n}   (${found.get(k).file})`)
}

log('\n--- which of the interesting ones are MISSING ---')
const interesting = [
  'MessageItemAudio', 'MessageItemVoice', 'MessageItemRecord',
  'MessageItemComment', 'MessageItemShareComment', 'MessageItemShareAweme',
  'MessageItemShareUser', 'MessageItemShareMerge', 'MessageItemWebShareCard',
  'MessageItemLocation', 'MessageItemLive', 'MessageItemNewRefMessage',
  'MessageItemUnsuport', 'MessageItemHi', 'MessageItemGroupAnnouncement',
  'MessageItemGroupInvite', 'MessageItemText', 'MessageItemImage', 'MessageItemEmoji',
  'MessageItemVideo', 'MessageItemBigEmoji', 'MessageItemRedEnvelope',
]
for (const k of interesting) {
  if (!found.has(k)) log(`  MISSING: ${k}`)
}

process.exit(0)

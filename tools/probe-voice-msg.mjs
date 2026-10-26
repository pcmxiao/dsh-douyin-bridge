/**
 * tools/probe-voice-msg.mjs —— 找 VOICE 消息类型的枚举值 + message/send 载荷结构
 * ============================================================================
 * 已知：网页 UI 没有录音入口，但消息类型枚举里有 VOICE / IM_ENCRYPT_VOICE。
 *       所以只能走协议层。那就得知道：
 *         ① VOICE 的枚举值是多少
 *         ② message/send 的 content 怎么拼（图片那条路是 batch_build_image）
 *
 * 用法：node tools/probe-voice-msg.mjs
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

const texts = []
for (const url of scripts || []) {
  try {
    const r = await fetch(url, { headers: { referer: 'https://www.douyin.com/' } })
    if (!r.ok) continue
    const t = Buffer.from(await r.arrayBuffer()).toString('utf8')
    if (t.length) texts.push({ url, t })
  } catch { /* skip */ }
}
log(`下载了 ${texts.length} 个 JS`)

// ── ① VOICE 枚举定义 ───────────────────────────────────────────
log('\n════ ① VOICE 枚举 ════')
const enumSnips = new Set()
for (const { url, t } of texts) {
  for (const m of t.matchAll(/VOICE/g)) {
    const i = m.index
    const snip = t.slice(Math.max(0, i - 700), i + 700).replace(/\s+/g, ' ')
    if (/IM_ENCRYPT_VOICE|IM_TYPE|SHARE_AWEME|MessageType|IMMsgType/i.test(snip)) {
      const key = snip.slice(0, 120)
      if (!enumSnips.has(key)) { enumSnips.add(key); log(`\n--- ${url.split('/').pop().slice(0, 50)} @${i}`); log(snip) }
    }
    if (enumSnips.size >= 3) break
  }
  if (enumSnips.size >= 3) break
}
if (!enumSnips.size) log('  （没找到枚举定义）')

// ── ② message/send 的载荷结构 ─────────────────────────────────
log('\n\n════ ② message/send 载荷 ════')
const sendSnips = new Set()
for (const { url, t } of texts) {
  for (const m of t.matchAll(/batch_build_image|batchBuildImage|build_image/gi)) {
    const i = m.index
    const snip = t.slice(Math.max(0, i - 500), i + 700).replace(/\s+/g, ' ')
    const key = snip.slice(0, 100)
    if (!sendSnips.has(key)) { sendSnips.add(key); log(`\n--- ${url.split('/').pop().slice(0, 50)} @${i}`); log(snip) }
  }
  if (sendSnips.size >= 3) break
}
if (!sendSnips.size) log('  （没找到 batch_build_image）')

// ── ③ 找「消息类型 → payload」的映射表 ─────────────────────────
log('\n\n════ ③ 消息类型映射 ════')
const mapSnips = new Set()
for (const { url, t } of texts) {
  for (const m of t.matchAll(/case\s+[\w.]+\.pp\.VOICE/g)) {
    const i = m.index
    const snip = t.slice(Math.max(0, i - 1400), i + 400).replace(/\s+/g, ' ')
    const key = snip.slice(0, 100)
    if (!mapSnips.has(key)) { mapSnips.add(key); log(`\n--- @${i}`); log(snip) }
  }
  if (mapSnips.size >= 2) break
}

process.exit(0)

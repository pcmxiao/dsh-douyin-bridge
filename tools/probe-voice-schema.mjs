/**
 * tools/probe-voice-schema.mjs —— 找语音消息的 content 字段结构
 * ============================================================================
 * 已知消息类型：VOICE=17 / IM_ENCRYPT_VOICE=109 / ENCRYPT_VOICE=501
 * 消息 content 是个 JSON 字符串（渲染时 JSON.parse(l)）。
 * 需要知道：语音那条 JSON 里有哪些字段（时长？url？uri？波形？）
 *
 * 用法：node tools/probe-voice-schema.mjs
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
    texts.push({ url, t: Buffer.from(await r.arrayBuffer()).toString('utf8') })
  } catch { /* skip */ }
}
log(`下载 ${texts.length} 个 JS\n`)

// ① 语音消息渲染：找 wave / duration / voiceUrl 之类的字段
log('════ ① 语音渲染用到的字段 ════')
const FIELD_CANDIDATES = [
  'voiceUrl', 'voice_url', 'voiceUri', 'voice_uri', 'playUrl', 'play_url',
  'waveform', 'duration', 'voiceDuration', 'voice_duration', 'resourceId',
  'resource_id', 'uri', 'encryptVoice', 'encrypt_voice', 'voiceType',
]
const found = new Map()
for (const { url, t } of texts) {
  for (const f of FIELD_CANDIDATES) {
    const re = new RegExp(`\\b${f}\\b`, 'g')
    const m = t.match(re)
    if (m && m.length) {
      const i = t.indexOf(f)
      const snip = t.slice(Math.max(0, i - 260), i + 320).replace(/\s+/g, ' ')
      const key = f + '|' + snip.slice(0, 80)
      if (!found.has(key)) found.set(key, { f, n: m.length, snip, file: url.split('/').pop().slice(0, 40) })
    }
  }
}
const shown = new Set()
for (const { f, n, snip, file } of found.values()) {
  if (shown.has(f)) continue
  shown.add(f)
  log(`\n  【${f}】${n} 处 (${file})`)
  log(`    ${snip}`)
}
if (!shown.size) log('  （没找到候选字段）')

// ② 语音消息在 UI 上怎么渲染的（点击播放 → 取 URL）
log('\n\n════ ② 语音气泡渲染 ════')
for (const { url, t } of texts) {
  for (const m of t.matchAll(/MessageItemAudio[a-zA-Z]*/g)) {
    const i = m.index
    const snip = t.slice(Math.max(0, i - 200), i + 400).replace(/\s+/g, ' ')
    log(`\n--- @${i}: ${snip}`)
    break
  }
}

// ③ 上传时 FileType 的合法取值（options.type 从哪来）
log('\n\n════ ③ upload options.type 的取值 ════')
const types = new Set()
for (const { url, t } of texts) {
  for (const m of t.matchAll(/type\s*:\s*["'](image|video|voice|audio|file|doc)["']/g)) {
    types.add(m[1])
  }
  for (const m of t.matchAll(/FileType["'\s:]{1,4}(image|video|voice|audio)/g)) {
    types.add('FileType:' + m[1])
  }
}
log('  ' + ([...types].join(', ') || '（没找到）'))

process.exit(0)

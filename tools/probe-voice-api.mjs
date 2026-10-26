/**
 * tools/probe-voice-api.mjs —— 从页面 JS bundle 里找「语音发送」的实现
 * ============================================================================
 * 目的：网页 UI 上没有麦克风按钮，但抖音手机端能发语音 ⇒
 *       协议层（upload + message/send）大概率支持，只是网页没做入口。
 *       所以去翻它加载的 JS，看有没有：
 *         · 「按住说话」「语音」等中文串
 *         · FileType / audio / voice 相关的上传参数
 *         · 消息 content 里的语音类型枚举
 *
 * 用法：node tools/probe-voice-api.mjs
 */
import { getBrowser } from '../lib/browser.mjs'
import { loadConfig } from '../lib/state.mjs'

const cfg = loadConfig()
const log = (m) => console.log(m)
const b = await getBrowser({ reuse: true, port: cfg.browserPort, log })

// ① 收集页面加载的 JS 资源
const scripts = await b.eval(`(() => {
  const urls = new Set()
  for (const s of document.querySelectorAll('script[src]')) urls.add(s.src)
  // performance 里也捞一遍（动态 import 的 chunk）
  for (const e of performance.getEntriesByType('resource')) {
    if (/\\.js(\\?|$)/.test(e.name)) urls.add(e.name)
  }
  return [...urls]
})()`)
log(`页面 JS 资源 ${scripts?.length ?? 0} 个`)

// ② 逐个抓下来搜关键词
const PATTERNS = [
  ['中文-按住说话', '按住说话'],
  ['中文-语音', '语音'],
  ['中文-录音', '录音'],
  ['中文-发送语音', '发送语音'],
  ['FileType枚举', 'FileType'],
  ['audio上传', 'audio/'],
  ['voice字段', 'voice'],
  ['audio字段', 'audio'],
  ['消息类型-voice', 'msgType'],
  ['content类型', 'contentType'],
]

const hits = {}
let fetched = 0
for (const url of scripts || []) {
  let txt
  try {
    const r = await fetch(url, { headers: { referer: 'https://www.douyin.com/' } })
    if (!r.ok) continue
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length > 60 * 1024 * 1024) continue
    txt = buf.toString('utf8')
    fetched++
  } catch { continue }
  for (const [label, pat] of PATTERNS) {
    const re = new RegExp(pat, 'g')
    const m = txt.match(re)
    if (m && m.length) {
      ;(hits[label] ??= { n: 0, files: new Set(), samples: [] })
      hits[label].n += m.length
      hits[label].files.add(url.split('/').pop().slice(0, 60))
      if (hits[label].samples.length < 6) {
        // 取命中处上下文
        const i = txt.indexOf(pat)
        hits[label].samples.push(txt.slice(Math.max(0, i - 90), i + 110).replace(/\s+/g, ' '))
      }
    }
  }
}

log(`\n成功下载 ${fetched} 个 JS\n`)
for (const [label] of PATTERNS) {
  const h = hits[label]
  if (!h) { log(`  ✘ ${label} —— 没有任何命中`); continue }
  log(`  ✔ ${label} —— ${h.n} 处，分布在 ${h.files.size} 个文件`)
  for (const s of h.samples.slice(0, 3)) log(`      … ${s}`)
}

// ③ 专门找 FileType= 的取值（上传时决定文件类型）
log('\n════ FileType 取值枚举 ════')
const seen = new Set()
for (const url of scripts || []) {
  let txt
  try {
    const r = await fetch(url, { headers: { referer: 'https://www.douyin.com/' } })
    if (!r.ok) continue
    txt = Buffer.from(await r.arrayBuffer()).toString('utf8')
  } catch { continue }
  for (const m of txt.matchAll(/FileType[=:"'\s]{1,4}([a-zA-Z0-9_]{2,20})/g)) {
    const k = m[1]
    if (!seen.has(k)) {
      seen.add(k)
      const i = m.index
      log(`  ${k}  …${txt.slice(Math.max(0, i - 70), i + 90).replace(/\s+/g, ' ')}`)
    }
  }
  if (seen.size > 40) break
}
if (!seen.size) log('  （没找到 FileType= ）')

process.exit(0)

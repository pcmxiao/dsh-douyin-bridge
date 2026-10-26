/**
 * tools/probe-voice.mjs —— 探测抖音私信面板的「语音发送」入口
 * ============================================================================
 * 目的：搞清楚网页端到底能不能发语音条。
 *
 * 要查的：
 *   ① 输入框工具栏上有没有麦克风 / 按住说话 按钮
 *   ② 页面上有没有隐藏的音频录制相关节点（audio / MediaRecorder / getUserMedia）
 *   ③ 有没有「按住说话」的长按交互（mousedown → 长按 → 松开）
 *   ④ 抖音的语音发送上传链路是什么（web API 里有没有 voice/upload 之类）
 *
 * 用法：
 *   node tools/probe-voice.mjs <好友名>
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

// ── 0. 导航到抖音（页面可能是 about:blank）──────────────────────
const where = await b.eval('location.href').catch(() => '')
if (!/douyin\.com/.test(String(where))) {
  log(`当前在 ${where}，导航到抖音首页…`)
  await b.goto('https://www.douyin.com/', { settleMs: 10000 })
  const now = await b.eval('location.href').catch(() => '')
  log(`  → ${now}`)
  if (!/douyin\.com/.test(String(now))) { log('✘ 导航失败'); process.exit(1) }
}

// ── 0b. 确保在私信界面 ───────────────────────────────────────────
const st = await ensurePanel(b)
log(`面板: ${JSON.stringify({ panelOpen: st.panelOpen, inChat: st.inChat, convCount: st.convCount })}`)
if (!st.inChat) {
  const ok = await enterChat(b, peer)
  log(`进会话「${peer}」: ${ok}`)
  if (!ok) { log('✘ 进不去'); process.exit(1) }
}

// ── ① 输入框区域完整枚举（含 svg 图标的 use/href 线索）───────────
const scope = await b.eval(`(() => {
  const input = document.querySelector('[data-e2e="msg-input"]')
  if (!input) return { found: false }
  // 输入框往上找 3 层，覆盖整条工具栏
  let root = input
  for (let i = 0; i < 4 && root.parentElement; i++) {
    const r = root.getBoundingClientRect()
    if (r.width > 300 && r.height > 60) break
    root = root.parentElement
  }
  const rr = root.getBoundingClientRect()
  const items = []
  for (const el of root.querySelectorAll('*')) {
    const r = el.getBoundingClientRect()
    if (r.width < 5 || r.height < 5) continue
    const cls = String(el.className?.baseVal ?? el.className ?? '')
    // 只要叶子节点和图标，别把整个容器刷出来
    const isIcon = el.tagName === 'svg' || el.tagName === 'use' || el.tagName === 'img'
    const isLeaf = el.children.length === 0
    if (!isIcon && !isLeaf) continue
    items.push({
      tag: el.tagName.toLowerCase(),
      cls: cls.slice(0, 70),
      e2e: el.getAttribute('data-e2e') || '',
      title: el.getAttribute('title') || '',
      aria: el.getAttribute('aria-label') || '',
      role: el.getAttribute('role') || '',
      // svg 图标里的 path 形状往往能看出是什么图标
      paths: el.tagName === 'svg'
        ? [...el.querySelectorAll('path')].map(p => (p.getAttribute('d') || '').slice(0, 40)).join('|').slice(0, 120)
        : '',
      useHref: el.tagName === 'use' ? (el.getAttribute('href') || el.getAttribute('xlink:href') || '').slice(0, 80) : '',
      src: el.tagName === 'img' ? (el.getAttribute('src') || '').slice(0, 80) : '',
      txt: (el.innerText || '').trim().slice(0, 20),
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.left), y: Math.round(r.top),
    })
  }
  return { found: true, rootCls: String(root.className || '').slice(0, 80), rw: Math.round(rr.width), rh: Math.round(rr.height), items }
})()`)

log('\n════ ① 输入框区域元素 ════')
if (!scope?.found) { log('  ✘ 没找到 [data-e2e="msg-input"]') } else {
  log(`  根容器: ${scope.rootCls}  ${scope.rw}×${scope.rh}`)
  for (const it of scope.items) {
    const extra = it.paths ? ` paths=${it.paths}` : (it.useHref ? ` use=${it.useHref}` : (it.src ? ` src=${it.src}` : ''))
    log(`   <${it.tag}> ${it.w}×${it.h} @${it.x},${it.y} e2e=${it.e2e || '-'} title=${it.title || '-'} aria=${it.aria || '-'}`)
    log(`        cls=${it.cls}${extra}`)
  }
}

// ── ② 关键词全局搜：语音/按住说话/录音 ──────────────────────────
const kw = await b.eval(`(() => {
  const words = ['按住说话','语音','录音','麦克风','voice','Voice','audio','Audio','record','Record','mic','Mic','按住']
  const hits = []
  for (const el of document.querySelectorAll('*')) {
    const t = (el.getAttribute?.('title') || '') + '|' + (el.getAttribute?.('aria-label') || '') + '|' +
              (el.getAttribute?.('placeholder') || '') + '|' + (el.className?.baseVal ?? el.className ?? '') + '|' +
              (el.children.length === 0 ? (el.innerText || '') : '')
    for (const w of words) {
      if (t.includes(w)) {
        const r = el.getBoundingClientRect()
        hits.push({
          word: w,
          tag: el.tagName.toLowerCase(),
          cls: String(el.className?.baseVal ?? el.className ?? '').slice(0, 70),
          e2e: el.getAttribute('data-e2e') || '',
          title: el.getAttribute('title') || '',
          aria: el.getAttribute('aria-label') || '',
          ph: el.getAttribute('placeholder') || '',
          txt: (el.innerText || '').trim().slice(0, 40),
          w: Math.round(r.width), h: Math.round(r.height),
          x: Math.round(r.left), y: Math.round(r.top),
        })
        break
      }
    }
  }
  // 去重（同一个元素可能被多个词命中）
  const seen = new Set()
  return hits.filter(h => { const k = h.tag + h.cls + h.x + h.y; if (seen.has(k)) return false; seen.add(k); return true })
})()`)
log('\n════ ② 语音相关关键词命中 ════')
if (!kw?.length) log('  （页面上一个都没有 —— 网页端可能确实不支持发语音）')
for (const h of kw) {
  log(`  [${h.word}] <${h.tag}> ${h.w}×${h.h} @${h.x},${h.y} e2e=${h.e2e || '-'}`)
  log(`        cls=${h.cls} title=${h.title || '-'} aria=${h.aria || '-'} ph=${h.ph || '-'}`)
  if (h.txt) log(`        txt=${h.txt}`)
}

// ── ③ 音频节点 / MediaRecorder 能力 ────────────────────────────
const audio = await b.eval(`(() => ({
  audioEls: [...document.querySelectorAll('audio')].map(a => ({ cls: String(a.className||'').slice(0,50), src: (a.src||'').slice(0,80), dur: a.duration })),
  hasMR: typeof MediaRecorder !== 'undefined',
  hasGUM: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
  hasRecorderCtor: typeof window.Recorder !== 'undefined',
}))()`)
log('\n════ ③ 音频能力 ════')
log(JSON.stringify(audio, null, 1))

// ── ④ 有没有 video/audio 上传入口（录制完怎么发）────────────────
const upload = await b.eval(`(() => {
  const out = []
  for (const el of document.querySelectorAll('input[type=file]')) {
    const r = el.getBoundingClientRect()
    out.push({ accept: el.accept || '', multiple: !!el.multiple, visible: r.width > 0 && r.height > 0,
      parentCls: String(el.parentElement?.className || '').slice(0, 60) })
  }
  return out
})()`)
log('\n════ ④ input[type=file] ════')
log(upload?.length ? JSON.stringify(upload, null, 1) : '  （没有）')

process.exit(0)

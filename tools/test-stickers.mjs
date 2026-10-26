/**
 * tools/test-stickers.mjs —— 本地表情库：抓 → 存 → 列 → 发
 * ============================================================================
 *   node tools/test-stickers.mjs grab [videoId]     # 从评论区收集表情
 *   node tools/test-stickers.mjs list               # 看库里有什么
 *   node tools/test-stickers.mjs send <peer> [key]  # 发一个给好友
 */
import { getBrowser } from '../lib/browser.mjs'
import { loadConfig } from '../lib/state.mjs'
import { openVideoPage } from '../lib/comment.mjs'
import { grabSticker, listStickers, findSticker, stickerPath, stickerStats } from '../lib/stickers.mjs'
import { sendImage } from '../lib/douyin.mjs'

const cfg = loadConfig()
const log = (m) => console.log(m)
const mode = process.argv[2] || 'list'

if (mode === 'list') {
  const st = stickerStats()
  log(`库：${st.count} 个，${(st.bytes / 1024).toFixed(1)} KB`)
  log(`目录：${st.dir}`)
  log(`类型：${JSON.stringify(st.kinds)}`)
  for (const s of listStickers({ limit: 30 })) {
    log(`  ${s.id}  ${s.name}  ${s.bytes}B  from=${s.from || '-'}  tags=${(s.tags || []).join(',')}`)
  }
  process.exit(0)
}

if (mode === 'send') {
  const peer = process.argv[3] || ''
  const key = process.argv[4] || ''
  if (!peer) { log('用法: send <peer> [key]'); process.exit(1) }
  // 🔴 用 findSticker 而不是 listStickers({limit}).find() ——
  //    后者只在前 N 条里找，库里一多就找不到。
  const st = key ? findSticker(key) : listStickers({ limit: 1 })[0]
  if (!st) { log(`库里没有 ${key || '(空库)'}`); process.exit(1) }
  const p = stickerPath(st)
  if (!p) { log(`文件不见了：${st.file}`); process.exit(1) }
  log(`发 ${st.id} ${st.name} (${st.bytes}B ${st.ext}) -> ${peer}`)
  const b = await getBrowser({ reuse: true, port: cfg.browserPort, log })
  // 先把页面拉回能开私信面板的地方（视频页打不开面板）
  const cur = await b.eval('location.href').catch(() => '')
  if (!/douyin\.com\/(jingxuan|$|\?|discover|user|search)/.test(String(cur))) {
    await b.goto('https://www.douyin.com/', { settleMs: 6000 })
  }
  const r = await sendImage({ browser: b, file: p, uname: peer })
  log(`send: ${JSON.stringify(r)}`)
  process.exit(r.ok ? 0 : 1)
}

if (mode === 'grab') {
  const b = await getBrowser({ reuse: true, port: cfg.browserPort, log })
  const ids = process.argv[3]
    ? [process.argv[3]]
    : ['7700169015465796002', '7697459346984897955', '7626666254741366949', '7585546894395313450']

  let opened = null
  for (let round = 0; round < 3 && !opened; round++) {
    for (const id of ids) {
      const page = await openVideoPage({ browser: b, ids: [id] })
      if (!page.ok) continue
      opened = id
      break
    }
  }
  if (!opened) { log('没打开任何视频页'); process.exit(1) }
  log(`视频：${opened}`)

  // 把评论区滚动几屏，多捞一些表情
  for (let i = 0; i < 4; i++) {
    await b.eval(`(() => {
      const list = document.querySelector('[data-e2e="comment-list"]')
      if (list) list.scrollTop = list.scrollHeight
      return true
    })()`).catch(() => {})
    await new Promise(r => setTimeout(r, 1200))
  }

  const urls = await b.eval(`(() => {
    const out = []
    const push = (src) => {
      if (!src || src.startsWith('data:')) return
      if (/aweme-avatar/.test(src)) return
      out.push(src)
    }
    for (const img of document.querySelectorAll('[data-e2e="comment-item"] img')) push(String(img.src || ''))
    const panel = document.querySelector('.emoji-card-outer-container')
    if (panel) for (const img of panel.querySelectorAll('img')) push(String(img.src || ''))
    return [...new Set(out)]
  })()`)
  log(`候选图：${urls.length}`)

  let saved = 0
  let dup = 0
  let fail = 0
  for (const u of urls) {
    // 传 browser：webp 会就地转成 png（抖音上传控件不认 webp）
    const r = await grabSticker({ url: u, from: `video:${opened}`, tags: ['评论区'], browser: b })
    if (r.ok) {
      if (r.duplicate) dup++
      else {
        saved++
        const cv = r.sticker.convertedFrom ? ` (${r.sticker.convertedFrom}->${r.sticker.ext})` : ''
        log(`  + ${r.sticker.id} ${r.sticker.name} ${r.sticker.bytes}B ${r.sticker.ext}${cv}`)
      }
    } else {
      fail++
      log(`  x ${u.slice(0, 70)} -> ${r.error}`)
    }
  }
  log(`\n新存 ${saved}，重复 ${dup}，失败 ${fail}`)
  const st = stickerStats()
  log(`库：${st.count} 个，${(st.bytes / 1024).toFixed(1)} KB，类型 ${JSON.stringify(st.kinds)}`)
  process.exit(0)
}

log('用法: node tools/test-stickers.mjs [grab|list|send] ...')
process.exit(1)

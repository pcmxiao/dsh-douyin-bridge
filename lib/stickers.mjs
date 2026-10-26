/**
 * lib/stickers.mjs —— 本地表情库
 * ============================================================================
 * 为什么是「存图」而不是「收藏到抖音账号」：
 *
 *   抖音的表情收藏**没有公开接口**，UI 上也没有「收藏这个表情」的入口
 *   （表情面板底部只有「表情 / GIF」两个 tab，格子上 hover、右键都没反应）。
 *   硬做要么调视觉识别、要么猜 DOM —— 都太脆。
 *
 *   但评论区里的表情本身就是**普通 CDN 图片**（实测三种来源都能直接抓）：
 *     · p*-pc-sign.douyinpic.com/obj/...     抖音自有表情
 *     · p-pc-weboff.byteimg.com/.../twemoji/ 标准 emoji
 *     · p*-ex-*.douyinpic.com/tos-cn-i-...   评论里的图片
 *   全都 200、不需要 referer、不需要 cookie。
 *
 *   所以走最稳的一条路：**抓图 → 存本地 → 当图片发出去**。
 *   发送复用已经跑通的 sendImage（发图链路是验证过的）。
 *
 * 目录结构（$DSH_HOME/douyin-bridge/stickers/）：
 *   index.json          清单：[{ id, file, name, tags, src, from, addedAt, bytes, w, h }]
 *   <id>.<ext>          图片本体
 *
 * @module lib/stickers
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { paths } from './state.mjs'

/** 表情库目录 */
export const STICKER_DIR = join(paths.dir, 'stickers')
const INDEX = join(STICKER_DIR, 'index.json')

/** 单个表情上限（抖音发图本身能到 20MB，这里留足） */
const MAX_BYTES = 8 * 1024 * 1024

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'

function ensureDir() {
  if (!existsSync(STICKER_DIR)) mkdirSync(STICKER_DIR, { recursive: true })
}

/**
 * 读清单。文件坏了就当空的，别让整个插件挂掉。
 * @returns {Array<object>}
 */
export function loadIndex() {
  try {
    const raw = readFileSync(INDEX, 'utf8')
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/** @param {Array<object>} arr */
function saveIndex(arr) {
  ensureDir()
  writeFileSync(INDEX, JSON.stringify(arr, null, 2))
}

/** 按 content-type 猜扩展名 */
function extOf(contentType, url = '') {
  const ct = String(contentType || '').toLowerCase()
  if (ct.includes('png')) return '.png'
  if (ct.includes('gif')) return '.gif'
  if (ct.includes('webp')) return '.webp'
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg'
  // content-type 不靠谱时退回看 URL
  const m = /\.(png|gif|webp|jpe?g)(?:\?|$)/i.exec(String(url))
  if (m) return '.' + m[1].toLowerCase().replace('jpeg', 'jpg')
  return '.png'
}

/** 从 URL 里抠一个可读的名字（抖音的表情没有语义名，只能凑合） */
function nameFromUrl(url) {
  const s = String(url)
  // twemoji: 1f49a.png -> 1f49a
  const tw = /twemoji\/\d+x\d+\/([0-9a-f-]+)\./i.exec(s)
  if (tw) return tw[1]
  // douyinpic obj: /obj/tos-cn-i-xxx/<hash>?...
  const obj = /\/obj\/[^/]+\/([0-9a-f]{8,})/i.exec(s)
  if (obj) return obj[1].slice(0, 12)
  const base = s.split('?')[0].split('/').pop() || 'sticker'
  return base.replace(/\.[a-z0-9]+$/i, '').slice(0, 24)
}

/**
 * 抓一张图并落盘。
 *
 * 🔴 只用 Node 的 fetch，**不要走页面内 fetch**：
 *    实测页面里 `fetch(cdnUrl)` 会撞 CORS（Failed to fetch），
 *    而 Node 直接抓三种 CDN 都是 200，连 referer 都不用带。
 *
 * 🔴 **webp 要转成 png**（这条是踩出来的）：
 *    抖音私信的上传控件只认 jpg/png/gif —— 实测 webp 塞进去之后
 *    「选完文件后没弹出『发送』确认框」，发不出去，而且报错完全不提格式。
 *    而评论区抓下来的表情里 webp 占大头（32 张里 18 张）。
 *    所以抓到 webp 就地转成 png（用浏览器 canvas，不用装 sharp）。
 *
 * @param {object} p
 * @param {string} p.url       图片地址
 * @param {string} [p.name]    自定义名字
 * @param {string[]} [p.tags]
 * @param {string} [p.from]    来源标记（video id / 好友名之类）
 * @param {object} [p.browser] 传了就用来把 webp 转 png（强烈建议传）
 * @returns {Promise<{ok:boolean, sticker?:object, error?:string, code?:string}>}
 */
export async function grabSticker({ url, name = '', tags = [], from = '', browser = null }) {
  const src = String(url || '').trim()
  if (!src) return { ok: false, error: '没给图片地址', code: 'NO_URL' }
  if (!/^https?:\/\//i.test(src)) return { ok: false, error: '只接受 http(s) 图片地址', code: 'BAD_URL' }

  let buf
  let ct = ''
  try {
    const res = await fetch(src, { headers: { 'user-agent': UA } })
    if (!res.ok) return { ok: false, error: `下载失败：HTTP ${res.status}`, code: 'HTTP_' + res.status }
    ct = res.headers.get('content-type') || ''
    if (!/^image\//i.test(ct)) {
      return { ok: false, error: `不是图片（content-type: ${ct || '空'}）`, code: 'NOT_IMAGE' }
    }
    buf = Buffer.from(await res.arrayBuffer())
  } catch (e) {
    return { ok: false, error: `下载失败：${e.message}`, code: 'FETCH_FAILED' }
  }

  if (!buf.length) return { ok: false, error: '下载到 0 字节', code: 'EMPTY' }

  // webp → png（浏览器 canvas，不引第三方库）
  let converted = false
  if (/webp/i.test(ct) && browser) {
    const png = await webpToPng(browser, buf).catch(() => null)
    if (png && png.length > 200) {
      buf = png
      ct = 'image/png'
      converted = true
    }
  }

  if (buf.length > MAX_BYTES) {
    return { ok: false, error: `图片太大（${(buf.length / 1048576).toFixed(1)}MB，上限 ${MAX_BYTES / 1048576}MB）`, code: 'TOO_BIG' }
  }

  // 内容指纹：同一张图存第二次就直接复用，不重复落盘
  const sha = createHash('sha256').update(buf).digest('hex')
  const short = sha.slice(0, 12)
  const index = loadIndex()
  const dup = index.find((s) => s.sha === sha)
  if (dup) {
    return { ok: true, sticker: dup, duplicate: true }
  }

  ensureDir()
  const ext = extOf(ct, converted ? '' : src)
  const id = short
  const file = `${id}${ext}`
  const abs = join(STICKER_DIR, file)
  try {
    writeFileSync(abs, buf)
  } catch (e) {
    return { ok: false, error: `写文件失败：${e.message}`, code: 'WRITE_FAILED' }
  }

  const sticker = {
    id,
    file,
    name: String(name || '').trim() || nameFromUrl(src),
    tags: (Array.isArray(tags) ? tags : []).map((t) => String(t).trim()).filter(Boolean),
    src,
    from: String(from || ''),
    sha,
    bytes: buf.length,
    ext,
    ...(converted ? { convertedFrom: 'webp' } : {}),
    addedAt: new Date().toISOString(),
  }
  index.push(sticker)
  saveIndex(index)
  return { ok: true, sticker }
}

/**
 * 用浏览器的 canvas 把 webp 转成 png。
 *
 * 为什么不用 sharp / jimp：多一个原生依赖，装起来慢还容易挂；
 * 而我们**本来就有浏览器**，canvas 转格式是它天生会的事。
 *
 * @param {object} browser
 * @param {Buffer} buf
 * @returns {Promise<Buffer>}
 */
async function webpToPng(browser, buf) {
  const b64 = buf.toString('base64')
  const js = String.raw`(async () => {
    const img = new Image()
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = () => reject(new Error('webp decode failed'))
      img.src = 'data:image/webp;base64,' + B64
    })
    const c = document.createElement('canvas')
    c.width = img.naturalWidth || img.width
    c.height = img.naturalHeight || img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    return String(c.toDataURL('image/png')).split(',')[1] || ''
  })()`.replace('B64', JSON.stringify(b64))
  const out = await browser.eval(js)
  if (!out) return null
  return Buffer.from(out, 'base64')
}

/**
 * 列本地表情库。
 * @param {object} [opt]
 * @param {string} [opt.query]  按名字/标签过滤
 * @param {number} [opt.limit]
 */
export function listStickers({ query = '', limit = 200 } = {}) {
  const q = String(query || '').trim().toLowerCase()
  let arr = loadIndex()
  if (q) {
    arr = arr.filter((s) => {
      const hay = [s.name, s.from, ...(s.tags || [])].join(' ').toLowerCase()
      return hay.includes(q)
    })
  }
  return arr.slice(0, Math.max(1, Number(limit) || 200))
}

/** 按 id 或名字找一个（名字支持部分匹配） */
export function findSticker(key) {
  const k = String(key || '').trim()
  if (!k) return null
  const arr = loadIndex()
  return arr.find((s) => s.id === k)
    || arr.find((s) => s.file === k)
    || arr.find((s) => s.name === k)
    || arr.find((s) => s.name.toLowerCase().includes(k.toLowerCase()))
    || null
}

/** 拿到表情的绝对路径（顺便确认文件还在） */
export function stickerPath(sticker) {
  if (!sticker || !sticker.file) return ''
  const p = join(STICKER_DIR, sticker.file)
  return existsSync(p) ? p : ''
}

/**
 * 删一个表情（文件和清单一起删）。
 * @param {string} key
 */
export function removeSticker(key) {
  const arr = loadIndex()
  const i = arr.findIndex((s) => s.id === key || s.file === key || s.name === key)
  if (i < 0) return { ok: false, error: '表情库里没有这个', code: 'NOT_FOUND' }
  const [gone] = arr.splice(i, 1)
  try {
    const p = join(STICKER_DIR, gone.file)
    if (existsSync(p)) unlinkSync(p)
  } catch { /* 文件删不掉也要把清单更新掉 */ }
  saveIndex(arr)
  return { ok: true, removed: gone }
}

/** 库的概况 */
export function stickerStats() {
  const arr = loadIndex()
  let bytes = 0
  for (const s of arr) {
    try {
      const p = join(STICKER_DIR, s.file)
      if (existsSync(p)) bytes += statSync(p).size
    } catch { /* 忽略单个文件的错误 */ }
  }
  return {
    count: arr.length,
    bytes,
    dir: STICKER_DIR,
    /** 库里的扩展名分布，方便一眼看出抓到了什么 */
    kinds: arr.reduce((acc, s) => {
      const e = s.ext || extname(s.file) || '?'
      acc[e] = (acc[e] || 0) + 1
      return acc
    }, {}),
  }
}

/**
 * 从视频评论区把表情图收集进本地库。
 *
 * 为什么是「抓图」而不是「收藏」：
 *   抖音的表情收藏**没有公开接口**，UI 上也没有入口（表情面板只有
 *   「表情 / GIF」两个 tab，格子上 hover、右键都没反应）。
 *   但评论区里的表情本身就是普通 CDN 图片，Node 直接 fetch 就是 200。
 *
 * @param {object} p
 * @param {object} p.browser
 * @param {string} [p.id]      视频 id（留空 = 用当前页面）
 * @param {string[]} [p.tags]
 * @param {number} [p.scrolls] 滚几屏多捞一些（默认 4）
 * @returns {Promise<object>}
 */
export async function grabFromVideo({ browser, id = '', tags = [], scrolls = 4 }) {
  const { openVideoPage } = await import('./comment.mjs')

  // 没给 id 就用当前页面；给了就打开
  if (id) {
    // 🔴 风控会随机把视频页重定向走 ⇒ 多试几次，别一次失败就报错
    const tries = [String(id), String(id), String(id)]
    let page = null
    for (const vid of tries) {
      page = await openVideoPage({ browser, ids: [vid] })
      if (page.ok) break
      await new Promise((r) => setTimeout(r, 1500))
    }
    if (!page?.ok) {
      return { ok: false, error: page?.error || '视频页打不开', code: page?.code || 'VIDEO_UNAVAILABLE' }
    }
  } else {
    const hasBox = await browser.eval(
      `Boolean(document.querySelector('.comment-input-inner-container'))`,
    ).catch(() => false)
    if (!hasBox) {
      return { ok: false, error: '当前页面不是视频页，也没给 video id', code: 'NO_VIDEO' }
    }
  }

  // 滚几屏，让虚拟列表把更多评论渲染出来
  for (let i = 0; i < Math.max(0, Number(scrolls) || 0); i++) {
    await browser.eval(`(() => {
      const list = document.querySelector('[data-e2e="comment-list"]')
      if (list) list.scrollTop = list.scrollHeight
      return true
    })()`).catch(() => {})
    await new Promise((r) => setTimeout(r, 1100))
  }

  // 把评论区 + 表情面板里所有图片都收上来（头像排除）
  const urls = await browser.eval(`(() => {
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
  })()`).catch(() => [])

  if (!urls.length) {
    return { ok: false, error: '这个视频的评论区里没找到表情图片', code: 'NO_IMAGES' }
  }

  const saved = []
  let dup = 0
  let fail = 0
  const errors = []
  for (const u of urls) {
    const r = await grabSticker({
      url: u,
      from: id ? `video:${id}` : 'current-page',
      tags: tags.length ? tags : ['评论区'],
      browser,
    })
    if (r.ok) {
      if (r.duplicate) dup++
      else saved.push({ id: r.sticker.id, name: r.sticker.name, ext: r.sticker.ext, bytes: r.sticker.bytes })
    } else {
      fail++
      if (errors.length < 5) errors.push(r.error)
    }
  }

  const st = stickerStats()
  return {
    ok: true,
    candidates: urls.length,
    saved: saved.length,
    duplicate: dup,
    failed: fail,
    newStickers: saved,
    ...(errors.length ? { errors } : {}),
    library: { total: st.count, bytes: st.bytes, kinds: st.kinds },
  }
}

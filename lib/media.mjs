/**
 * lib/media.mjs —— 非文本消息（图片 / 表情 / 语音 / 视频 / 位置）的识别与投递
 * ============================================================================
 * 为什么要单独一个文件：
 *
 * 抖音私信网页端支持十几种消息类型（从 CSS 类名里数出来的，实测 2026-10）：
 *
 *   MessageItemText*                    文本
 *   MessageItemImage*                   图片        ← 本次新增
 *   MessageItemEmoji*                   表情/贴纸   ← 本次新增
 *   MessageItemAudio*                   语音        ← 本次新增
 *   MessageItemVideo*                   视频
 *   MessageItemShareAweme*              分享的视频卡片
 *   MessageItemShareUser*               分享的用户
 *   MessageItemShareMerge*              合并转发
 *   MessageItemWebShareCard*            网页分享卡片
 *   MessageItemLocation*                位置
 *   MessageItemExchangePictureAndLocation*  图片+位置
 *   MessageItemLive*                    直播
 *   MessageItemNewRefMessage*           引用消息
 *   MessageItemUnsuport*                网页端渲染不了的类型（语音/红包等）
 *   MessageItemHi*                      Hi 表情
 *   MessageItemGroupAnnouncement* / GroupInvite*   群相关
 *
 * 🔴 之前这些消息**在桥接里等于不存在**：
 *    ① DOM 路径用 `innerText` 取正文 —— 图片/语音气泡的 innerText 是**空的**，
 *       于是 `if (!t) continue` 直接把它们丢掉了；
 *    ② 接口路径只认 `kind === 7`（文本），别的 kind 一律当空气。
 *    结果就是：对方发张图，AI 永远不知道。
 *
 * 这里做三件事：
 *   ① 在页面里认出每种类型 + 抽出能用的信息（图片字节、表情名、语音时长）
 *   ② 把接口路径和 DOM 路径的消息**合并**成一条有序列表
 *   ③ 把媒体消息变成人能读、模型能懂的文字（并把图片真的塞给模型看）
 */

/** 媒体类型 */
export const MEDIA = {
  TEXT: 'text',
  IMAGE: 'image',
  EMOJI: 'emoji',
  VOICE: 'voice',
  VIDEO: 'video',
  SHARE: 'share',
  LOCATION: 'location',
  UNSUPPORTED: 'unsupported',
  SYSTEM: 'system',
}

/**
 * ⭐ 页面里用的类型识别（生成一段 JS，嵌到 `browser.eval` 里跑）。
 *
 * 设计原则：**class 语义名优先**，data-e2e 兜底。
 * 实测抖音的 CSS Modules 保留了 `MessageItemImageImageBox` 这种语义名，
 * 比随机 hash 稳定（hash 每次构建都变，语义名只在他们改组件时才变）。
 *
 * @returns {string} JS 源码（IIFE）
 */
export function pageMediaHelper() {
  // ⚠️ 这里面**不能出现反引号** —— `browser.eval` 用的是模板字符串，
  //    裸反引号会把外层模板截断（踩过：`SyntaxError: missing ) after argument list`）。
  return String.raw`
    const MEDIA_CLASSES = [
      ['image',      'MessageItemImageImageBox'],
      ['emoji',      'MessageItemEmojiemojiBox'],
      ['voice',      'MessageItemAudiocontainer'],
      ['video',      'MessageItemVideovideoBox'],
      ['share',      'MessageItemShareAwemecontainer'],
      ['location',   'MessageItemLocationstackLayout'],
      ['unsupported','MessageItemUnsuportunsupport'],
      ['text',       'MessageItemTextcontainer'],
    ]

    const clsOf = (el) => String((el && el.className) || '')

    const findByCls = (root, needle) => {
      if (!root) return null
      // 直接命中
      if (clsOf(root).includes(needle)) return root
      const all = root.querySelectorAll ? root.querySelectorAll('div,span,a') : []
      for (const el of all) {
        if (clsOf(el).includes(needle)) return el
      }
      return null
    }

    const typeOf = (box) => {
      for (const [type, needle] of MEDIA_CLASSES) {
        if (findByCls(box, needle)) return type
      }
      return 'text'
    }

    // ⭐ 取图片要**先定位到类型容器，再取容器里的 img**。
    //    直接 box.querySelector('img') 会拿到**头像**（avatar 也在 box 里）——
    //    实测踩过：读出来是 p26.douyinpic.com/img/aweme-avatar… 而不是消息里的图。
    const CONTAINER_OF = {
      image: 'MessageItemImageImageBox',
      emoji: 'MessageItemEmojiemojiBox',
      video: 'MessageItemVideovideoBox',
    }

    const imgOf = (box, type) => {
      const needle = CONTAINER_OF[type]
      const holder = needle ? findByCls(box, needle) : null
      if (holder) {
        const img = holder.querySelector('img')
        if (img) return img.getAttribute('src') || ''
      }
      return ''
    }

    const textOf = (box, needle) => {
      const el = findByCls(box, needle)
      return el ? (el.innerText || '').trim() : ''
    }

    const sizeOf = (box) => {
      // 图片/视频气泡把宽高写在 inline style 里
      const holder = findByCls(box, 'MessageItemImageImageBox')
        || findByCls(box, 'MessageItemVideovideoBox')
        || findByCls(box, 'MessageItemEmojiemojiBox')
      if (!holder) return { w: 0, h: 0 }
      const st = holder.getAttribute('style') || ''
      const mw = /width:\s*(\d+)px/.exec(st)
      const mh = /height:\s*(\d+)px/.exec(st)
      if (mw && mh) return { w: Number(mw[1]), h: Number(mh[1]) }
      const r = holder.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height) }
    }

    // 语音时长（秒）
    const voiceSeconds = (box) => {
      const raw = textOf(box, 'MessageItemAudioduration') || textOf(box, 'MessageItemAudiovoiceText')
      const m = /(\d+(?:\.\d+)?)/.exec(raw)
      if (m) return Number(m[1])
      const sec = /(\d+)\s*秒/.exec(raw)
      return sec ? Number(sec[1]) : 0
    }
  `
}

/**
 * 把一条消息变成「人能读 / 模型能懂」的描述。
 *
 * ⚠️ 措辞要**中性**：这条描述既可能是对方发的、也可能是自己发的，
 *    写成「对方发来…」在回看自己的消息时会误导模型。
 *
 * @param {object} m 消息
 * @returns {string}
 */
export function describeMedia(m) {
  if (!m) return ''
  const media = m.media || {}
  switch (m.type) {
    case MEDIA.IMAGE: {
      const dim = media.width && media.height ? ` ${media.width}×${media.height}` : ''
      return `[图片${dim}]`
    }
    case MEDIA.EMOJI:
      return `[表情${media.name ? '：' + media.name : ''}]`
    case MEDIA.VOICE:
      return `[语音${media.seconds ? ' ' + media.seconds + ' 秒' : ''}]`
    case MEDIA.VIDEO:
      return '[视频]'
    case MEDIA.LOCATION:
      return `[位置${media.name ? '：' + media.name : ''}]`
    case MEDIA.SHARE:
      return `[分享卡片${media.title ? '：' + media.title : ''}]`
    case MEDIA.UNSUPPORTED:
      return '[网页端显示不了的消息]'
    default:
      return m.text || ''
  }
}

/* ── 表情名对照表 ────────────────────────────────────────────────── */

/**
 * 表情气泡里**没有名字**（`boxText` 是空的），
 * 但表情面板里每一格都带名字（续火花 / 比心 / 在干嘛 / 笑死…）。
 *
 * ⇒ 用「图片地址 → 名字」建一张对照表，面板打开时抓一次，缓存起来。
 */
const emojiNames = new Map()

/**
 * 表情的 key 用**路径**，不用整条 URL。
 *
 * 🔴 同一个表情在面板里是 `p11-sign.douyinpic.com/obj/im-resource/xxx`，
 *    在消息气泡里可能是 `p26-sign.douyinpic.com/obj/im-resource/xxx` ——
 *    **CDN 子域名会变**（实测 p3 / p9 / p11 / p26 都出现过）。
 *    用整条 URL 做 key 就对不上 ⇒ 表情名永远查不到。
 */
function emojiKey(src) {
  const s = String(src || '')
  const i = s.indexOf('/obj/')
  // ⚠️ **必须去掉查询串**（?lk3s=…&x-signature=…）。
  //    面板里的地址和气泡里的地址签名参数**不一样**（签名是按请求算的），
  //    带查询串就永远对不上 ⇒ 表情名查不到（实测踩过）。
  if (i >= 0) return s.slice(i).split('?')[0]
  try {
    return new URL(s).pathname
  } catch {
    return s.split('?')[0]
  }
}

/**
 * 记一批表情（src → 名字）。
 *
 * @param {Array<{src:string, name:string}>} entries
 */
export function rememberEmojiNames(entries) {
  for (const e of entries || []) {
    if (e?.src && e.name) {
      const key = emojiKey(e.src)
      if (!emojiNames.has(key)) emojiNames.set(key, e.name)
    }
  }
}

/**
 * 查表情名。
 *
 * @param {string} src
 * @returns {string}
 */
export function lookupEmojiName(src) {
  if (!src) return ''
  return emojiNames.get(emojiKey(src)) || ''
}

/**
 * 已经记住多少个表情名（自检用）。
 */
export function emojiNameCount() {
  return emojiNames.size
}

/**
 * `data:image/png;base64,....` → 字节。
 *
 * 抖音网页端把私信里的图片**转成 base64 内嵌**（`batch_build_image` 干的），
 * 所以 DOM 里拿到的就是图片本体，不用再去 CDN 下载。
 *
 * @param {string} dataUrl
 * @returns {{bytes: Uint8Array, mediaType: string} | null}
 */
export function dataUrlToBytes(dataUrl) {
  const s = String(dataUrl || '')
  const m = /^data:([^;,]+)?(;base64)?,/.exec(s)
  if (!m) return null
  const mediaType = m[1] || 'application/octet-stream'
  const isB64 = Boolean(m[2])
  const payload = s.slice(m[0].length)
  try {
    if (isB64) {
      return { bytes: new Uint8Array(Buffer.from(payload, 'base64')), mediaType }
    }
    return { bytes: new Uint8Array(Buffer.from(decodeURIComponent(payload), 'utf8')), mediaType }
  } catch {
    return null
  }
}

/**
 * 合并「接口路径」和「DOM 路径」的消息。
 *
 * 为什么要合：
 *   · 接口路径拿得到**准确时间戳**和**历史**，但只认文本消息（kind=7）
 *   · DOM 路径什么都看得见（图片、表情、语音），但只有当前窗口、时间是相对的
 *
 * 合并规则：以接口列表为底（顺序、时间戳），把 DOM 里多出来的**媒体消息**
 * 插到它在 DOM 里相邻的文本消息后面。
 *
 * @param {Array} api 接口路径的消息（旧的→新的）
 * @param {Array} dom DOM 路径的消息（旧的→新的）
 * @returns {Array}
 */
export function mergeMessages(api, dom) {
  const apiList = Array.isArray(api) ? api.slice() : []
  const domList = Array.isArray(dom) ? dom.slice() : []
  if (!domList.length) return apiList
  if (!apiList.length) return domList

  const sameText = (a, b) => {
    const ta = String(a.text || '').trim()
    const tb = String(b.text || '').trim()
    if (!ta || !tb) return false
    return ta === tb || ta.slice(0, 24) === tb.slice(0, 24)
  }

  const out = []
  let ai = 0
  for (const d of domList) {
    if (d.type && d.type !== MEDIA.TEXT) {
      // 媒体消息：插到当前 API 位置
      out.push(d)
      continue
    }
    // 文本消息：往后找匹配的 API 消息
    let found = -1
    for (let k = ai; k < apiList.length; k++) {
      if (apiList[k].fromMe === d.fromMe && sameText(apiList[k], d)) { found = k; break }
    }
    if (found >= 0) {
      // 把 API 消息（带准确时间戳）放进去
      for (let k = ai; k <= found; k++) out.push(apiList[k])
      ai = found + 1
    } else {
      out.push(d)
    }
  }
  // API 里剩下的（DOM 窗口之外的更早消息）补回最前面
  for (let k = 0; k < ai; k++) out.push(apiList[k])
  return out
}

/**
 * 消息指纹里要带上媒体信息 —— 否则两张不同的图片会被当成同一条。
 *
 * @param {object} m
 * @returns {string}
 */
export function mediaFingerprintPart(m) {
  if (!m || !m.media) return ''
  const parts = [m.type || '']
  if (m.media.sha) parts.push(m.media.sha)
  if (m.media.url) parts.push(m.media.url.slice(-40))
  if (m.media.name) parts.push(m.media.name)
  if (m.media.seconds) parts.push(String(m.media.seconds))
  return parts.join(':')
}

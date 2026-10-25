/**
 * lib/douyin.mjs —— 抖音的全部操作（搜索 / 详情 / 分享 / 私信）
 * ============================================================================
 * 两条路并存：
 *
 *   ① **接口路**（首选，稳）：`lib/douyin-api.mjs` hook 住抖音自己的
 *      `imapi.douyin.com` 请求，解 protobuf。字段号是接口契约，改版很少动，
 *      也不受窗口尺寸影响。
 *   ② **DOM 路**（兜底）：点击 + 读 innerText。脆，但接口挂了还能用。
 *
 * 读私信走 ①，失败自动落 ②。发消息目前只能走 ②（发消息的 protobuf 请求
 * 要自己拼 + 签名，成本高，暂不做）。
 *
 * 🔴 每个按钮的点击方式都不一样（实测，别瞎改）：
 *   打开「消息」面板  → 叶子节点逐层 dispatchEvent（toggle，点两次会关）
 *   打开分享面板      → Input.dispatchMouseEvent
 *   点「分享」按钮    → 先 hover，再 el.click()
 *   进聊天            → dispatchEvent
 *   发消息            → JS focus() + insertText（输入框可能在视口外）
 * ============================================================================
 */
import { SEL, pageFindHelper, canary } from './selectors.mjs'
import {
  installHook as apiInstallHook,
  hookReady as apiHookReady,
  drain as apiDrain,
  pickMessages as apiPickMessages,
  selfInfo as apiSelfInfo,
  triggerFetch as apiTriggerFetch,
  cacheMessages as apiCacheMessages,
  cachedMessages as apiCachedMessages,
  clearCache as apiClearCache,
} from './douyin-api.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 解析工具 ────────────────────────────────────────────────────

/** "11.7万" → 117000 */
export function parseCount(s) {
  const t = String(s || '').trim()
  const m = /^([\d.]+)\s*([万亿wkm]?)$/i.exec(t)
  if (!m) return 0
  const n = parseFloat(m[1])
  if (!Number.isFinite(n)) return 0
  const u = (m[2] || '').toLowerCase()
  const mul = u === '万' || u === 'w' ? 1e4
    : u === '亿' ? 1e8
      : u === 'k' ? 1e3
        : u === 'm' ? 1e6 : 1
  return Math.round(n * mul)
}

/** "08:28" → 508 */
export function parseDuration(s) {
  const parts = String(s || '').trim().split(':').map(Number)
  if (parts.some((x) => !Number.isFinite(x))) return 0
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return 0
}

/** "5小时前" / "10月16日" → ISO */
export function parseTime(s, now = new Date()) {
  const t = String(s || '').trim()
  if (!t) return ''
  let d = null
  let m = /^(\d+)\s*(秒|分钟|小时|天)前$/.exec(t)
  if (m) {
    const n = Number(m[1])
    const u = m[2]
    const ms = u === '秒' ? n * 1000
      : u === '分钟' ? n * 60000
        : u === '小时' ? n * 3600000
          : n * 86400000
    d = new Date(now.getTime() - ms)
  } else if (t === '刚刚') d = now
  else if (t === '昨天') d = new Date(now.getTime() - 86400000)
  else if (t === '前天') d = new Date(now.getTime() - 2 * 86400000)
  else {
    m = /^(\d{1,2})月(\d{1,2})日$/.exec(t)
    if (m) {
      d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]))
      if (d > now) d.setFullYear(d.getFullYear() - 1)
    }
  }
  return d ? d.toISOString() : ''
}

// ── 搜索 ────────────────────────────────────────────────────────

/**
 * 搜索视频。
 *
 * ⭐ 卡片结构（实测）：
 *   容器 `.search-result-card`
 *   内部：时长 / 播放量 / 标题(字号最大) / 作者 / 时间
 *
 * 🔴 不要用纯文本正则切 —— 标题和描述会混在一起。
 *
 * @param {object} p { browser, keyword, limit }
 */
export async function search({ browser, keyword, limit = 20 }) {
  const kw = String(keyword || '').trim()
  if (!kw) return []

  await browser.goto(`https://www.douyin.com/search/${encodeURIComponent(kw)}?type=video`, { settleMs: 11000 })

  const gate = await browser.eval(`(() => {
    const t = document.body ? document.body.innerText : ''
    return { loginWall: /登录后即可搜索|请先登录|扫码登录/.test(t) }
  })()`)
  if (gate.loginWall) {
    const e = new Error('抖音搜索需要登录。先跑：douyin-digest login')
    e.code = 'NEEDS_LOGIN'
    throw e
  }

  const raw = await browser.eval(`(() => {
    const out = []
    let cards = [...document.querySelectorAll('.search-result-card')]
    if (!cards.length) {
      const seen = new Set()
      for (const a of document.querySelectorAll('a[href*="/video/"]')) {
        let box = a
        for (let i = 0; i < 5 && box.parentElement; i++) {
          box = box.parentElement
          if (/\\d{1,2}:\\d{2}/.test(box.innerText || '')) break
        }
        if (!seen.has(box)) { seen.add(box); cards.push(box) }
      }
    }

    for (const card of cards) {
      const a = card.querySelector('a[href*="/video/"]')
      const m = a ? /\\/video\\/(\\d+)/.exec(a.getAttribute('href') || '') : null
      const id = m ? m[1] : ''

      const leaves = []
      for (const el of card.querySelectorAll('*')) {
        if (el.children.length > 0) continue
        const t = (el.innerText || '').trim()
        if (!t) continue
        const r = el.getBoundingClientRect()
        if (r.width === 0) continue
        leaves.push({ text: t, y: Math.round(r.top), fontSize: parseFloat(getComputedStyle(el).fontSize) || 0 })
      }

      let duration = '', playText = '', timeText = '', author = ''
      const titleCand = []
      for (const l of leaves) {
        const t = l.text
        if (/^\\d{1,2}:\\d{2}(?::\\d{2})?$/.test(t)) { duration = t; continue }
        // ⚠️ 播放量在时长之后，所以条件是「playText 没填」，不是「duration 没填」
        if (!playText && /^[\\d.]+[万亿]?$/.test(t) && t.length <= 6) { playText = t; continue }
        if (/^(\\d+\\s*(秒|分钟|小时|天)前|刚刚|昨天|前天|\\d{1,2}月\\d{1,2}日)$/.test(t)) { timeText = t; continue }
        if (t === '@') continue
        titleCand.push(l)
      }

      // 🔴 作者名：@ 符号和昵称是**两个独立节点**（实测 2026-10）。
      //    卡片底部那一行的结构是：  [@] [昵称] [时间]
      //      · @ 符号    x=207, y=402, fs=14
      //      · 昵称      x=223, y=402, fs=14   ← 要的就是它
      //      · 时间      x=289, y=402, fs=12
      //
      //    ⚠️ 一张卡里可能有**多个** @（比如「合集」区域里也有 @昵称），
      //    所以取 **y 最大**的那个（最靠下 = 卡片底部作者行）。
      const atMarks = leaves.filter((l) => l.text === '@')
      const atMark = atMarks.sort((a, b) => b.y - a.y)[0]
      if (atMark) {
        const near = leaves
          .filter((l) => l !== atMark
            && Math.abs(l.y - atMark.y) < 6
            && l.x > atMark.x
            && l.text.length <= 24
            && !/^\\d/.test(l.text))
          .sort((a, b) => a.x - b.x)
        if (near.length) author = near[0].text
      }
      // 兜底：卡片里没有 @ 标记时（少见的布局），
      // 只在**最底下那一行**（y 最大的几个叶子）里找昵称，
      // 避免抓到卡片顶部的「合集」「置顶」这类标签。
      if (!author) {
        const maxY = Math.max(...leaves.map((l) => l.y))
        const a = leaves
          .filter((l) => maxY - l.y < 10)
          .find((l) => l.text.length <= 20
            && !l.text.includes('#')
            && l.fontSize <= 14
            && !/^[\\d@]/.test(l.text)
            && !/前$|^昨天|^刚刚|^合集$|^置顶$/.test(l.text))
        if (a) author = a.text
      }

      titleCand.sort((a, b) => b.fontSize - a.fontSize || a.y - b.y)
      const titleRaw = titleCand[0]?.text || ''
      const tags = [...titleRaw.matchAll(/#([^\\s#]+)/g)].map(x => x[1])
      const title = titleRaw.replace(/\\s*#[^\\s#]+/g, '').trim()

      if (!id && !title) continue
      out.push({ id, title, tags, author, duration, playText, timeText })
      if (out.length >= ${Math.max(limit * 2, 20)}) break
    }
    return out
  })()`)

  if (!Array.isArray(raw)) return []

  return raw.map((r) => ({
    platform: 'douyin',
    id: r.id,
    url: r.id ? `https://www.douyin.com/video/${r.id}` : '',
    title: r.title,
    author: r.author,
    tags: r.tags || [],
    durationSec: parseDuration(r.duration),
    play: parseCount(r.playText),
    publishedAt: parseTime(r.timeText),
  })).filter((c) => c.title).slice(0, limit)
}

// ── 详情 ────────────────────────────────────────────────────────

/**
 * 读视频详情：文案 + 话题 + 数据 + 评论。
 *
 * ⭐ 文案不是叶子元素 —— 正文和话题 `#xxx` 是分开的节点。
 *    做法：找左侧的话题 span，往上找父级直到长度合适。
 *
 * ⭐ 评论：`.Eh0a5CD4` 是单条容器，
 *    文本格式 `用户名 ▸ 内容 ▸ 时间·地区 ▸ 点赞 ▸ 分享 ▸ 回复`（换行分隔）
 */
export async function detail({ browser, id, commentLimit = 20 }) {
  const vid = String(id || '').trim()
  if (!vid) return { ok: false, error: '没有视频 id' }

  await browser.goto(`https://www.douyin.com/video/${vid}`, { settleMs: 11000 })
  try {
    await browser.eval('window.scrollBy(0, 500)')
    await sleep(2500)
  } catch { /* 滚不动算了 */ }

  const d = await browser.eval(`(() => {
    const out = { desc: '', tags: [], author: '', stats: {}, comments: [] }

    // ① 文案：从话题 span 往上找
    const hashSpans = []
    for (const el of document.querySelectorAll('span, a, div')) {
      if (el.children.length > 0) continue
      const t = (el.innerText || '').trim()
      if (!t.startsWith('#') || t.length < 3) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.left > 1100) continue
      hashSpans.push({ el, y: r.top })
    }
    if (hashSpans.length) {
      hashSpans.sort((a, b) => a.y - b.y)
      let node = hashSpans[0].el
      for (let i = 0; i < 6 && node.parentElement; i++) {
        const t = (node.innerText || '').trim()
        if (t.length >= 20 && t.length <= 700 && t.includes('#')) { out.desc = t; break }
        node = node.parentElement
      }
      if (!out.desc) {
        const t = (node.innerText || '').trim()
        if (t.length <= 1000) out.desc = t
      }
    }
    // 兜底
    if (!out.desc) {
      let best = ''
      for (const el of document.querySelectorAll('div')) {
        if (el.children.length > 3) continue
        const t = (el.innerText || '').trim()
        if (t.length < 20 || t.length > 700 || !/[#@]/.test(t)) continue
        const r = el.getBoundingClientRect()
        if (r.left > 1100 || r.top > 750) continue
        if (t.length > best.length) best = t
      }
      out.desc = best
    }

    out.tags = [...out.desc.matchAll(/#([^\\s#@]+)/g)].map(m => m[1]).slice(0, 12)
    const am = /@([^\\s#@]+)/.exec(out.desc)
    if (am) out.author = am[1]

    // ①-b 正文里没有 @ 时，从 DOM 里单独找作者名。
    //
    //     视频页右侧作者区一般有指向 /user/ 的链接，文字就是昵称。
    //     实测（2026-10）：不少视频的 desc 里**不带 @**，
    //     只靠正则抓 desc 会拿到空字符串。
    if (!out.author) {
      const cands = []
      for (const a of document.querySelectorAll('a[href*="/user/"]')) {
        const t = (a.innerText || '').trim()
        if (!t || t.length > 30) continue
        // 过滤掉「关注」「私信」这类按钮文字
        if (/^(关注|已关注|私信|分享|举报|更多)$/.test(t)) continue
        const r = a.getBoundingClientRect()
        if (r.width === 0) continue
        cands.push({ t, x: Math.round(r.left), y: Math.round(r.top), area: r.width * r.height })
      }
      // 作者名一般在整个页面最靠上、最靠左的那个用户链接
      cands.sort((p, q) => p.y - q.y || p.x - q.x)
      if (cands.length) out.author = cands[0].t
    }

    // ② 统计：底部那排数字，左到右 = 赞 评 藏 分
    const nums = []
    const vh = innerHeight
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 0) continue
      const t = (el.innerText || '').trim()
      if (!/^[\\d.]+[万亿]?$/.test(t)) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.top < vh * 0.55 || r.left > 1100) continue
      nums.push({ text: t, x: Math.round(r.left) })
    }
    nums.sort((a, b) => a.x - b.x)
    const keys = ['digg', 'comment', 'collect', 'share']
    nums.slice(0, 4).forEach((n, i) => { out.stats[keys[i]] = n.text })

    // ③ 评论
    const seen = new Set()
    for (const el of document.querySelectorAll('.Eh0a5CD4, [class*="CommentItem"]')) {
      const r = el.getBoundingClientRect()
      if (r.width < 300 || r.height < 50) continue
      const t = (el.innerText || '').trim()
      if (!t || t.length < 8) continue

      const lines = t.split('\\n').map(s => s.trim()).filter(Boolean)
      const user = lines[0] || ''
      const body = lines.slice(1).filter(l =>
        !/^(作者|置顶)$/.test(l)
        && !/^(\\d+\\s*(秒|分钟|小时|天)前|昨天|前天|\\d{1,2}月\\d{1,2}日)(\\s*·\\s*\\S+)?$/.test(l)
        && !/^\\d+$/.test(l)
        && !/^(分享|回复|展开\\d+条回复|收起)$/.test(l)
        && l !== '·' && l !== '...'
      )
      const text = body.join(' ').replace(/^[.．…]+\\s*/, '').trim()
      if (!text || text.length < 2) continue

      const key = (user + '|' + text).slice(0, 60)
      if (seen.has(key)) continue
      seen.add(key)

      const likeLine = lines.find(l => /^\\d+$/.test(l))
      out.comments.push({ user: user.slice(0, 30), text: text.slice(0, 200), like: likeLine ? Number(likeLine) : 0 })
      if (out.comments.length >= 30) break
    }

    return out
  })()`)

  return {
    ok: true,
    id: vid,
    url: `https://www.douyin.com/video/${vid}`,
    desc: String(d.desc || '').slice(0, 800),
    tags: d.tags || [],
    author: d.author || '',
    stats: Object.fromEntries(Object.entries(d.stats || {}).map(([k, v]) => [k, parseCount(v)])),
    comments: (d.comments || []).slice(0, commentLimit),
  }
}

// ── 分享 ────────────────────────────────────────────────────────

/** 分享面板开着吗 */
async function panelOpen(b) {
  return b.eval(`(() => {
    for (const el of document.querySelectorAll('div')) {
      const r = el.getBoundingClientRect()
      if (r.width < 150 || r.width > 700 || r.height < 100) continue
      const cs = getComputedStyle(el)
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue
      if (/分享给朋友|复制链接/.test(el.innerText || '')) return true
    }
    return false
  })()`)
}

/** 某个好友那行变成「捎句话」= 分享成功 */
async function sharedTo(b, friendName) {
  return b.eval(`(() => {
    let panel = null
    for (const el of document.querySelectorAll('div')) {
      const r = el.getBoundingClientRect()
      if (r.width < 150 || r.width > 700 || r.height < 100) continue
      const cs = getComputedStyle(el)
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue
      if (!/分享给朋友|复制链接/.test(el.innerText || '')) continue
      panel = el; break
    }
    if (!panel) return false
    const name = ${JSON.stringify(String(friendName || ''))}
    for (const el of panel.querySelectorAll('*')) {
      if (el.children.length > 0) continue
      if ((el.innerText || '').trim() !== '捎句话') continue
      if (!name) return true
      let n = el
      for (let i = 0; i < 4 && n.parentElement; i++) {
        n = n.parentElement
        if ((n.innerText || '').includes(name)) return true
      }
    }
    return false
  })()`)
}

/**
 * 分享视频给互关好友。
 *
 * 🔴 成功判据不是"面板关闭"——**面板永远不关**。
 *    而是那个好友的按钮从「分享」变成「捎句话」。
 */
export async function share({ browser, id, to = '', dryRun = false, note = '' }) {
  const vid = String(id || '').trim()
  if (!vid) return { ok: false, error: '没有视频 id' }

  await browser.goto(`https://www.douyin.com/video/${vid}`, { settleMs: 9000 })
  await browser.eval('window.scrollTo(0, 0)')

  /**
   * 🔴 视频页状态很不稳定（抖音风控抖动）：
   *    同一个 id 有时能打开、有时被重定向到首页、有时只有壳没内容。
   *
   *    ⇒ 不靠固定等待，改成**轮询等分享按钮出现**（最多 20 秒）。
   *       期间如果发现被重定向，立刻判定不可用。
   */
  let ready = null
  for (let i = 0; i < 20; i++) {
    ready = await browser.eval(`(() => {
      const url = location.href
      const len = (document.body ? document.body.innerText : '').length
      const hasVideo = Boolean(document.querySelector('video'))
      const btn = document.querySelector('[data-e2e="video-share-icon-container"]')
      const hasShare = Boolean(btn)
      let rect = null
      if (btn) {
        const r = btn.getBoundingClientRect()
        rect = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }
      }
      return { url, len, hasVideo, hasShare, rect, redirected: !/\\/video\\//.test(url) }
    })()`)

    if (ready.hasShare && ready.rect) break
    if (ready.redirected && i >= 3) break   // 连续 3 次都被重定向，认了
    await sleep(1000)
  }

  if (!ready?.hasShare || !ready.rect) {
    return {
      ok: false,
      code: 'VIDEO_UNAVAILABLE',
      error: ready?.redirected
        ? `视频页被重定向到 ${ready.url}（视频已删除 / 受限 / 风控）`
        : `视频页没就绪（${ready?.len || 0} 字，hasVideo=${ready?.hasVideo}，等了 20 秒）`,
      debug: ready,
    }
  }

  const pos = {
    x: ready.rect.x,
    y: ready.rect.y,
    w: ready.rect.w,
    h: ready.rect.h,
    via: 'data-e2e',
  }

  if (!pos) return { ok: false, error: '找不到分享按钮（页面结构可能变了）' }

  // 找分享按钮
  //
  // 🔴🔴 2026-10 抖音改版：分享按钮从「点击」变成了「**悬停**」。
  //
  //    证据（探针实测）：
  //      <DIV data-e2e="video-share-icon-container" class="bJX7d7PL o2tLobnl">
  //        React props: onMouseEnter, onMouseLeave     ← 只有这两个，**没有 onClick**
  //
  //    所以：
  //      · `Input.dispatchMouseEvent` 点击 → 完全没反应（不是坐标错，是没绑 onClick）
  //      · `mouseMoved` 悬停上去 → 面板立刻出现
  //
  //    ⚠️ 用 `data-e2e="video-share-icon-container"` 定位 —— 这是官方测试属性，
  //       比 class（构建时随机串）稳得多。之前的 `.sB3y0d3B` 只是里面的数字。

  /**
   * 打开面板：**悬停，不是点击**。
   *
   * 先移到别处再移回来 —— 这样能确保触发 onMouseEnter
   * （如果鼠标已经在按钮上，再 mouseMoved 到同一坐标不会触发 enter）。
   *
   * ⚠️ 有时第一次悬停不生效（页面还在懒加载 React 组件）。
   *    加长重试间隔，并在失败时再等一轮。
   */
  let opened = false
  for (let attempt = 0; attempt < 4 && !opened; attempt++) {
    // 移开
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 100, button: 'none', buttons: 0 }, browser.sessionId)
    await sleep(800)
    // 移上去（触发 onMouseEnter）
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y, button: 'none', buttons: 0 }, browser.sessionId)
    await sleep(attempt === 0 ? 2500 : 3500)

    opened = await panelOpen(browser)
    if (!opened) await sleep(1500)
  }

  if (!opened) {
    /**
     * 悬停打不开时，再确认一次页面状态 —— 可能是视频本身加载失败。
     */
    const check = await browser.eval(`(() => ({
      url: location.href,
      len: (document.body ? document.body.innerText : '').length,
      hasVideo: Boolean(document.querySelector('video')),
      videoReady: (() => {
        const v = document.querySelector('video')
        return v ? { readyState: v.readyState, paused: v.paused, duration: v.duration } : null
      })(),
    }))()`)

    return {
      ok: false,
      code: 'PANEL_NOT_OPEN',
      error: `分享面板没弹出（悬停 4 次，坐标 ${pos.x},${pos.y} ${pos.w}×${pos.h} via=${pos.via}）`,
      debug: check,
    }
  }

  /**
   * 找好友 + 分享按钮位置。
   *
   * 🔴 坑：面板里**会列出自己**（当前登录的小号）。
   *    截图确认过：分享面板第一行永远是**自己**，所以必须按名字匹配好友。
   *    如果直接取第一个，会把视频分享给自己 —— 大号那边什么都收不到。
   *
   *    修法：
   *      · 传了 `to` → 按名字匹配
   *      · 没传 → **跳过自己**，取第一个不是自己的
   *
   *    怎么判断"自己"：拿会话列表里自己的名字（小号昵称），
   *    从私信面板的会话列表第一项或页面头像取。
   */
  const myName = await browser.eval(`(() => {
    // 从个人主页链接取昵称
    for (const a of document.querySelectorAll('a[href*="/user/"]')) {
      const href = a.getAttribute('href') || ''
      if (!/\\/user\\/self/.test(href)) continue
      const t = (a.innerText || '').trim()
      if (t && t !== '我的') return t
    }
    // 兜底：右上角头像的 alt / title
    const img = document.querySelector('header img, [class*="avatar"] img')
    if (img) {
      const alt = img.getAttribute('alt') || img.getAttribute('title') || ''
      if (alt) return alt.trim()
    }
    return ''
  })()`).catch(() => '')

  const btn = await browser.eval(`(() => {
    let panel = null
    for (const el of document.querySelectorAll('div')) {
      const r = el.getBoundingClientRect()
      if (r.width < 150 || r.width > 700 || r.height < 100) continue
      const cs = getComputedStyle(el)
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue
      if (!/分享给朋友|复制链接/.test(el.innerText || '')) continue
      panel = el; break
    }
    if (!panel) return null

    const want = ${JSON.stringify(String(to || ''))}
    const me = ${JSON.stringify(String(myName || ''))}
    const cands = []

    for (const el of panel.querySelectorAll('*')) {
      if (el.children.length > 0) continue
      if ((el.innerText || '').trim() !== '分享') continue
      const r = el.getBoundingClientRect()
      if (r.width === 0) continue
      let rowText = ''
      let n = el
      for (let i = 0; i < 4 && n.parentElement; i++) {
        n = n.parentElement
        const s = (n.innerText || '').trim().replace(/\\n/g, ' ')
        if (s && s.length < 40 && s !== '分享') { rowText = s; break }
      }
      // 🔴 行文本会带未读数：「好友名 3 分享」「好友名 分享」。
      //    只去掉末尾的「分享」不够 —— 名字后面会残留一个数字，
      //    后面按名字匹配好友时就失配了（实测拿到过 "菜就多练练 3"）。
      const friend = rowText
        .replace(/\\s*分享\\s*$/, '')      // 去掉末尾「分享」
        .replace(/\\s+\\d{1,3}\\s*$/, '')   // 去掉末尾未读数
        .trim()
      cands.push({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), friend })
    }

    if (!cands.length) return null

    // 指定了名字 → 精确匹配（这是唯一可靠的用法）
    if (want) {
      const hit = cands.find(c => c.friend.includes(want))
      return hit || null
    }

    // 没指定 → 跳过已知的自己
    if (me) {
      const others = cands.filter(c => !c.friend.includes(me))
      if (others.length) return others[0]
    }

    /**
     * ⚠️ 不知道"自己"是谁时的兜底：取**第二个**。
     *
     *    实测（2026-10）：面板第一行永远是**当前登录的账号自己**
     *    （面板第一行永远是**自己**，所以必须按名字匹配好友）。
     *    所以第二个才是真正的朋友。
     *
     *    这个假设不牢靠 —— 如果面板只有一个人，就退回第一个。
     *    所以**强烈建议用 --to 指定收件人**。
     */
    return cands[1] || cands[0]
  })()`)

  if (!btn) return { ok: false, error: to ? `面板里没找到好友「${to}」` : '面板里没有「分享」按钮' }

  if (dryRun) {
    await closePanel(browser)
    return { ok: true, dryRun: true, friend: btn.friend }
  }

  /**
   * 点分享。
   *
   * 🔴🔴 这里踩过一个大坑：
   *    之前写的是「遍历面板里所有『分享』按钮，点第一个」——
   *    结果**永远点的是第一行**（也就是自己），目标好友根本没收到。
   *
   *    ⇒ 必须按 `btn.friend` 精确匹配那一行再点。
   */
  let ok = false
  for (let i = 0; i < 3 && !ok; i++) {
    const clicked = await browser.eval(`(() => {
      let panel = null
      for (const el of document.querySelectorAll('div')) {
        const r = el.getBoundingClientRect()
        if (r.width < 150 || r.width > 700 || r.height < 100) continue
        const cs = getComputedStyle(el)
        if (cs.position !== 'fixed' && cs.position !== 'absolute') continue
        if (!/分享给朋友|复制链接/.test(el.innerText || '')) continue
        panel = el; break
      }
      if (!panel) return { err: 'panel gone' }

      const want = ${JSON.stringify(String(btn.friend))}

      for (const x of panel.querySelectorAll('*')) {
        if (x.children.length > 0) continue
        const t = (x.innerText || '').trim()
        // 只点还写着「分享」的（已经变成「捎句话」的跳过）
        if (t !== '分享') continue
        if (x.getBoundingClientRect().width === 0) continue

        // 往上找行，看这一行是不是目标好友
        let rowText = ''
        let n = x
        for (let d = 0; d < 4 && n.parentElement; d++) {
          n = n.parentElement
          const s = (n.innerText || '').trim().replace(/\\n/g, ' ')
          if (s && s.length < 40 && s !== '分享') { rowText = s; break }
        }
        const friend = rowText.replace(/\\s*分享\\s*$/, '').trim()
        if (!friend.includes(want)) continue

        x.click()
        return { ok: true, friend }
      }
      return { err: 'target row not found or already shared' }
    })()`)

    if (clicked.err) {
      // 可能已经点过了（按钮变成「捎句话」）
      if (await sharedTo(browser, btn.friend)) { ok = true; break }
      await sleep(1500)
      continue
    }

    await sleep(2800)
    if (await sharedTo(browser, btn.friend)) { ok = true; break }
  }

  // 捎句话：卡片分享成功后，按钮变成「捎句话」，点它可以附带一句自己的话
  let noteSent = false
  let noteError = ''
  if (ok && note && String(note).trim()) {
    const n = await sendNote(browser, btn.friend, String(note).trim())
    noteSent = Boolean(n.ok)
    if (!n.ok) noteError = n.error || '捎句话没发出去'
  }

  await closePanel(browser)
  return ok
    ? { ok: true, friend: btn.friend, noteSent, ...(noteError ? { noteError } : {}) }
    : { ok: false, friend: btn.friend, error: '点了「分享」但按钮没变成「捎句话」' }
}

/**
 * 在已经分享过卡片的那一行点「捎句话」，然后输入并发送一句话。
 *
 * 流程（抖音网页端）：卡片分享成功后，该好友的按钮从「分享」变成「捎句话」；
 * 点它会打开一个输入框（视频卡片已经挂在那儿了），输入文字回车即发出一条
 * 「视频 + 你的话」。
 *
 * ⚠️ 这一步的 DOM 结构比「点分享」更不稳定 ⇒ **失败不牵连卡片分享**，
 *    调用方拿到 `{ ok:true, noteSent:false, noteError }` 知道话没捎出去。
 */
async function sendNote(b, friendName, note) {
  const clicked = await b.eval(`(() => {
    let panel = null
    for (const el of document.querySelectorAll('div')) {
      const r = el.getBoundingClientRect()
      if (r.width < 150 || r.width > 700 || r.height < 100) continue
      const cs = getComputedStyle(el)
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue
      if (!/分享给朋友|复制链接/.test(el.innerText || '')) continue
      panel = el; break
    }
    if (!panel) return { err: '分享面板没了' }

    const want = ${JSON.stringify(String(friendName || ''))}
    for (const x of panel.querySelectorAll('*')) {
      if (x.children.length > 0) continue
      const t = (x.innerText || '').trim()
      if (t !== '捎句话') continue
      if (x.getBoundingClientRect().width === 0) continue

      let rowText = ''
      let n = x
      for (let d = 0; d < 4 && n.parentElement; d++) {
        n = n.parentElement
        const s = (n.innerText || '').trim().replace(/\\n/g, ' ')
        if (s && s.length < 40 && s !== '捎句话') { rowText = s; break }
      }
      const friend = rowText.replace(/\\s*捎句话\\s*$/, '').trim()
      if (friend && want && !friend.includes(want)) continue

      x.click()
      return { ok: true }
    }
    return { err: '没找到「捎句话」按钮' }
  })()`)

  if (clicked.err) return { ok: false, error: clicked.err }
  await sleep(1800)

  const focused = await b.eval(`(() => {
    const ta = document.querySelector('textarea')
    const ce = [...document.querySelectorAll('[contenteditable="true"]')].find(x => x.getBoundingClientRect().width > 60)
    const el = (ta && ta.getBoundingClientRect().width > 60) ? ta : ce
    if (!el) return null
    el.focus()
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }
  })()`)
  if (!focused) return { ok: false, error: '「捎句话」输入框没出现' }

  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: focused.x, y: focused.y, button: 'left', clickCount: 1 }, b.sessionId)
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: focused.x, y: focused.y, button: 'left', clickCount: 1 }, b.sessionId)
  await sleep(300)
  await b.send('Input.insertText', { text: note }, b.sessionId)
  await sleep(800)

  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, b.sessionId)
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, b.sessionId)
  await sleep(2500)

  const left = await b.eval(`(() => {
    const ta = document.querySelector('textarea')
    const ce = [...document.querySelectorAll('[contenteditable="true"]')].find(x => x.getBoundingClientRect().width > 60)
    const el = (ta && ta.getBoundingClientRect().width > 60) ? ta : ce
    return el ? (el.value || el.innerText || '').replace(/\\u200b/g, '').trim() : ''
  })()`)
  if (left) return { ok: false, error: '输入框里还有字，可能没发出去' }
  return { ok: true }
}

async function closePanel(b) {
  try {
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 60, y: 400, button: 'left', clickCount: 1 }, b.sessionId)
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 60, y: 400, button: 'left', clickCount: 1 }, b.sessionId)
  } catch { /* 忽略 */ }
}

// ── 私信 ────────────────────────────────────────────────────────

/**
 * 打开私信面板（toggle：开着就别再点）
 *
 * 🔴 踩过的坑：
 *   1. 「消息」按钮是 **toggle** —— 面板开着时再点会关掉
 *   2. 视频页**没有**「消息」按钮（在详情页跑 dm 会失败）
 *      ⇒ 先确认在首页，不在就导航过去
 */
/**
 * 把浏览器窗口撑大。
 *
 * 🔴 抖音私信面板对窗口尺寸极其挑剔，实测（2026-10，dpr 1.25 的 1920×1080 屏）：
 *   · 视口 1532 宽：会话列表能出来，但**聊天输入框落在 x=1707（视口外）** ——
 *     点不到、insertText 打不进去，焦点还留在 BODY 上。
 *     表现就是「发送返回 ok 但抖音里没这条」或「输入没生效」。
 *   · 视口 1532×791：面板可能干脆渲染不出来（DOM 里只有 0×0 的会话项）。
 *   ⇒ 私信面板要 **≥1800 宽**才完整落在视口里。
 *
 * ⚠️ 只能改**真实窗口尺寸**（`Browser.setWindowBounds`）。
 *    `Emulation.setDeviceMetricsOverride` 不管用 —— 抖音用自己算的宽度做布局。
 *
 * @returns {Promise<boolean>} 是否真的改了
 */
async function growWindow(b, vp = null) {
  const cur = vp || await b.eval(`({ w: innerWidth, h: innerHeight })`).catch(() => null)
  if (!cur) return false
  // 1800 是私信面板（列表 324 + 聊天区 ~500 + 边距）能完整显示的临界宽度
  if (cur.w >= 1800 && cur.h >= 900) return false

  try {
    const { windowId } = await b.send('Browser.getWindowForTarget', { targetId: b.targetId })
    await b.send('Browser.setWindowBounds', {
      windowId,
      // 1920×1040：1920 宽的屏上正好铺满可用区域
      bounds: { width: 1920, height: 1040, windowState: 'normal' },
    })
    await sleep(2500)
    const after = await b.eval(`({ w: innerWidth, h: innerHeight })`).catch(() => null)
    // 有些屏 / 缩放比例下系统会夹回去，把实际值记下来方便排障
    if (after) b._lastViewport = after
    return true
  } catch {
    // 拿不到窗口（headless / 某些平台）⇒ 退回 Emulation，聊胜于无
    try {
      await b.send('Emulation.setDeviceMetricsOverride', {
        width: 1920, height: 1040, deviceScaleFactor: cur.dpr || 1, mobile: false,
      }, b.sessionId)
      await sleep(1800)
      return true
    } catch { return false }
  }
}

async function ensurePanel(b) {
  // ① 先确保在能私信的页面（首页 / 搜索页 / 个人页都能，视频页不行）
  //
  // 🔴 一定要拦住 `about:blank` / `chrome://newtab` 这类**根本不是抖音**的页面。
  //    实测踩过：某次 goto 失败把标签页留在 about:blank，
  //    之后所有选择器都探测不到，表现成「面板打不开 / 找不到会话」，
  //    但报错信息完全不提页面是空的 —— 极难查。
  const where = await b.eval(`location.href`).catch(() => '')
  const onDouyin = /^https?:\/\/[^/]*douyin\.com(\/|$)/.test(String(where))
  if (!onDouyin) {
    await b.goto('https://www.douyin.com/jingxuan', { settleMs: 9000 })
    // 导航完再确认一次，还是不对就明确报错，别让上层瞎猜
    const after = await b.eval(`location.href`).catch(() => '')
    if (!/^https?:\/\/[^/]*douyin\.com(\/|$)/.test(String(after))) {
      return {
        inChat: false,
        panelOpen: false,
        convCount: 0,
        hasMsgBtn: false,
        vw: 0,
        vh: 0,
        error: `导航到抖音失败，当前页面是 ${after || '(读不到)'}`,
      }
    }
  }

  // 视频页不能私信，要回首页
  const canDM = /douyin\.com\/(jingxuan|$|\?|search|user)/.test(where) || where.endsWith('douyin.com/')
  if (onDouyin && !canDM) {
    await b.goto('https://www.douyin.com/', { settleMs: 8000 })
  }

  // ② 🔴 关键：窗口必须够大
  //    实测：宽 1378 时私信面板落在 x=1378（**完全在视口外**），点不到。
  //    实测：高 791 时（dpr 1.25 的 1920×1080 屏），面板点得着但**渲染不出来** ——
  //          DOM 里只有 1 个 0×0 的会话项，convCount 永远是 0。
  //    ⚠️ `Emulation.setDeviceMetricsOverride` 不管用 —— 抖音的布局用它自己算的宽度，
  //       设了之后面板还是在外面。
  //    ⇒ 改成**调真实窗口大小**（Browser.setWindowBounds），布局会正确重算。
  const vp = await b.eval(`({ w: innerWidth, h: innerHeight })`).catch(() => null)
  if (vp && (vp.w < 1800 || vp.h < 900)) {
    await growWindow(b, vp).catch(() => {})
  }

  // ③ 检查当前状态
  //
  // 🔴 判定面板开没开，**只看会话项有没有尺寸**（`ConversationItemwrapper` 的 rect）。
  //    以前用的是「宽度 250~600 且 innerText 含『消息』的 div」——那个条件经常假阴性：
  //    面板明明开着，会话项已经 324×67 了，但它匹配不上，于是代码以为没开，
  //    又去点一次「消息」⇒ toggle 把它关掉，永远打不开。
  const st = await b.eval(`(() => {
    const FIND = ${pageFindHelper()}
    const ta = document.querySelector('textarea')
    const ce = FIND.chatInput().filter((x) => x.getBoundingClientRect().width > 100)
    const inChat = Boolean((ta && ta.getBoundingClientRect().width > 100) || ce.length)

    // 会话项 = 面板是否真的渲染出来了（有尺寸才算）
    const convs = FIND.conversationItem()
    const shown = convs.filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 100 && r.height > 20
    })
    const pr = shown.length ? shown[0].getBoundingClientRect() : null

    // 「消息」入口：优先用 data-e2e="im-entry"（抖音自己的测试锚点，最稳），
    // 拿不到再退回「innerText 恰好是『消息』的叶子元素」
    let entry = null
    for (const sel of ['[data-e2e="im-entry"]', '[data-e2e="msg-entry"]']) {
      const el = document.querySelector(sel)
      if (el && el.getBoundingClientRect().width > 0) { entry = el; break }
    }
    if (!entry) {
      entry = [...document.querySelectorAll('*')].find(
        (el) => (el.innerText || '').trim() === '消息'
          && el.children.length === 0
          && el.getBoundingClientRect().width > 0,
      )
    }
    const mr = entry ? entry.getBoundingClientRect() : null

    return {
      inChat,
      panelOpen: shown.length > 0,
      convCount: shown.length,
      hasMsgBtn: Boolean(entry),
      msgVia: entry ? (entry.getAttribute('data-e2e') ? 'data-e2e' : 'text') : '',
      msgAt: mr ? { x: Math.round(mr.left + mr.width / 2), y: Math.round(mr.top + mr.height / 2) } : null,
      vw: innerWidth,
      vh: innerHeight,
      panelRect: pr ? { x: Math.round(pr.left), y: Math.round(pr.top), w: Math.round(pr.width), h: Math.round(pr.height), right: Math.round(pr.right) } : null,
    }
  })()`)

  if (st.inChat) return st

  // 🔴 只要面板开着就认 —— **不管在不在视口内**。
  //    因为 dispatchEvent 不需要坐标在视口内。
  //    ⚠️ 而且「消息」是 toggle：面板开着时再点会**关掉**。
  if (st.panelOpen) return st

  // ⑤ 面板没开：点「消息」的**叶子**元素（P / DIV 都行，只要能匹配到）
  if (!st.hasMsgBtn) {
    return { ...st, error: '当前页面没有「消息」按钮' }
  }

  // 优先真实鼠标（坐标在视口内时最稳），拿不到坐标再退回 dispatchEvent
  let clicked = false
  if (st.msgAt) {
    try {
      await b.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: st.msgAt.x, y: st.msgAt.y, button: 'left', clickCount: 1,
      }, b.sessionId)
      await b.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: st.msgAt.x, y: st.msgAt.y, button: 'left', clickCount: 1,
      }, b.sessionId)
      clicked = true
    } catch { /* 退回 dispatchEvent */ }
  }
  if (!clicked) {
    await b.eval(`(() => {
      const el = [...document.querySelectorAll('*')].find(
        (x) => (x.innerText || '').trim() === '消息'
          && x.children.length === 0
          && x.getBoundingClientRect().width > 0,
      )
      if (!el) return false
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      return true
    })()`)
  }
  await sleep(3000)

  // ⑥ 用同一套判定再读一次
  const READ_JS = `(() => {
    const FIND = ${pageFindHelper()}
    const convs = FIND.conversationItem()
    const shown = convs.filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 100 && r.height > 20
    })
    const ta = document.querySelector('textarea')
    const ce = FIND.chatInput().filter((x) => x.getBoundingClientRect().width > 100)
    const pr = shown.length ? shown[0].getBoundingClientRect() : null
    // 「消息」入口：优先 data-e2e，再退回文字
    let entry = document.querySelector('[data-e2e="im-entry"]') || document.querySelector('[data-e2e="msg-entry"]')
    if (!entry) {
      entry = [...document.querySelectorAll('*')].find(
        (el) => (el.innerText || '').trim() === '消息'
          && el.children.length === 0
          && el.getBoundingClientRect().width > 0,
      )
    }
    const mr = entry ? entry.getBoundingClientRect() : null
    return {
      inChat: Boolean((ta && ta.getBoundingClientRect().width > 100) || ce.length),
      panelOpen: shown.length > 0,
      convCount: shown.length,
      hasMsgBtn: Boolean(entry),
      msgAt: mr ? { x: Math.round(mr.left + mr.width / 2), y: Math.round(mr.top + mr.height / 2) } : null,
      vw: innerWidth, vh: innerHeight,
      panelRect: pr ? { x: Math.round(pr.left), y: Math.round(pr.top), w: Math.round(pr.width), h: Math.round(pr.height), right: Math.round(pr.right) } : null,
      ...(shown.length ? {} : { error: '面板没打开' }),
    }
  })()`

  let after = await b.eval(READ_JS)
  if (after.inChat || after.panelOpen) return after

  // ⑦ 🔴 兜底：真实鼠标点过还是没开 —— 说明点击落在了**没绑事件的容器**上。
  //    优先用 data-e2e="im-entry"（抖音自己的测试锚点），
  //    拿不到再退回「innerText 恰好是『消息』的叶子」逐层往上 dispatchEvent。
  const OPEN_JS = `(() => {
    // ① data-e2e 锚点：直接点它 + 往上两层（事件可能绑在父级）
    const entry = document.querySelector('[data-e2e="im-entry"]') || document.querySelector('[data-e2e="msg-entry"]')
    if (entry) {
      const o = { bubbles: true, cancelable: true, view: window }
      const chain = [entry, entry.parentElement, entry.parentElement?.parentElement].filter(Boolean)
      for (const el of chain) {
        try { el.dispatchEvent(new PointerEvent('pointerdown', o)) } catch (e) {}
        try { el.dispatchEvent(new MouseEvent('mousedown', o)) } catch (e) {}
        try { el.dispatchEvent(new PointerEvent('pointerup', o)) } catch (e) {}
        try { el.dispatchEvent(new MouseEvent('mouseup', o)) } catch (e) {}
        try { el.dispatchEvent(new MouseEvent('click', o)) } catch (e) {}
        try { el.click() } catch (e) {}
      }
      return 'e2e'
    }

    // ② 退回文字匹配 + 逐层点
    let leaf = null
    for (const el of document.querySelectorAll('*')) {
      if ((el.innerText || '').trim() !== '消息') continue
      if (el.children.length !== 0) continue
      if (el.getBoundingClientRect().width === 0) continue
      leaf = el; break
    }
    if (!leaf) return ''
    const chain = []
    let node = leaf
    for (let i = 0; i < 6 && node && node !== document.body; i++) { chain.push(node); node = node.parentElement }
    const o = { bubbles: true, cancelable: true, view: window }
    for (const el of chain) {
      try { el.dispatchEvent(new PointerEvent('pointerdown', o)) } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('mousedown', o)) } catch (e) {}
      try { el.dispatchEvent(new PointerEvent('pointerup', o)) } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('mouseup', o)) } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('click', o)) } catch (e) {}
    }
    return 'text'
  })()`

  const OPENED_JS = `(() => {
    const FIND = ${pageFindHelper()}
    return FIND.conversationItem()
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 100 && r.height > 20 }).length
  })()`

  for (let attempt = 0; attempt < 3; attempt++) {
    await b.eval(OPEN_JS)
    await sleep(2200)
    if (await b.eval(OPENED_JS) > 0) {
      after = await b.eval(READ_JS)
      return after
    }
    // 可能点开了又被点关（toggle）—— 再读一次状态再决定
    await sleep(800)
  }

  // ⑧ 最后再兜一次：窗口不够高时面板渲染不出来
  const grew = await growWindow(b, { w: after.vw, h: after.vh }).catch(() => false)
  if (grew) {
    await sleep(1500)
    await b.eval(OPEN_JS)
    await sleep(3000)
    after = await b.eval(READ_JS)
  }

  return after
}

/**
 * 进聊天界面。
 *
 * ⭐ 用语义化 class 定位（比坐标可靠）：
 *    `conversationConversationItemwrapper`  = 一个会话项（324×67）
 *       ├ `conversationConversationItemrowArea1`  头像区
 *       ├ `conversationConversationItemtitle`     好友名
 *       ├ `ConversationItemTagNextToTitlewrapper` 时间
 *       └ `ConversationItemDescwrapper`           消息预览
 *
 * 🔴 踩过的坑：
 *   1. 点外层容器 / 叶子都可能没反应 ⇒ **要试多层**
 *   2. 面板在窄窗口下会 `translateX(100%)` 滑出视口
 *      ⇒ dispatchEvent 可以，Input 不行
 *   3. 之前"找第一个含时间的元素"会命中嵌套内层，导致进错会话
 */
async function enterChat(b, uname = '') {
  const result = await b.eval(`(() => {
    const FIND = ${pageFindHelper()}
    // ⭐ 会话项（走降级链）
    let items = FIND.conversationItem()
    if (!items.length) {
      // 兜底：按尺寸和内容找
      const KW = ['分钟前', '小时前', '昨天', '刚刚']
      items = [...document.querySelectorAll('div')].filter((el) => {
        const r = el.getBoundingClientRect()
        if (r.width < 250 || r.width > 450) return false
        if (r.height < 50 || r.height > 120) return false
        const t = el.innerText || ''
        return KW.some(k => t.indexOf(k) >= 0)
      })
    }
    if (!items.length) return { err: 'no conversation items' }

    // 解析每个会话项
    //
    // 🔴 必须过滤掉 0×0 的**隐藏副本**：抖音的 DOM 里同时存在
    //    已经渲染的会话项和一个尺寸为 0 的旧副本。不过滤的话，
    //    排序后第一个可能是隐藏的那个 —— 点它什么都不会发生，
    //    而且它读出来的名字/时间也可能是过期的。
    const rows = items.map((el) => {
      const r = el.getBoundingClientRect()
      const t = (el.innerText || '').trim()
      const nameEl = FIND.one(el, 'conversationTitle')
      const timeEl = FIND.one(el, 'conversationTime')
      const descEl = FIND.one(el, 'conversationDesc')
      return {
        el,
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
        name: (nameEl?.innerText || '').trim() || (t.split(String.fromCharCode(10)).filter(Boolean)[0] || ''),
        time: (timeEl?.innerText || '').trim(),
        preview: (descEl?.innerText || '').trim().split(String.fromCharCode(10)).join(' '),
      }
    }).filter((x) => x.name && x.w > 100 && x.h > 20)

    if (!rows.length) return { err: 'no named rows' }
    rows.sort((a, b) => a.y - b.y)

    const want = ${JSON.stringify(String(uname || ''))}
    let target = rows[0]
    if (want) {
      const hit = rows.find(r => r.name.includes(want))
      if (!hit) return { err: 'not found', available: rows.map(r => r.name) }
      target = hit
    }

    // 🔴 多层点击（某些层级的事件是分开绑的）
    const fire = (el) => {
      if (!el) return
      const o = { bubbles: true, cancelable: true, view: window }
      try { el.dispatchEvent(new PointerEvent('pointerdown', o)) } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('mousedown', o)) } catch (e) {}
      try { el.dispatchEvent(new PointerEvent('pointerup', o)) } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('mouseup', o)) } catch (e) {}
      try { el.dispatchEvent(new MouseEvent('click', o)) } catch (e) {}
      try { el.click() } catch (e) {}
    }

    // 点 wrapper、它的父级、它的内容区
    fire(target.el)
    fire(target.el.parentElement)
    fire(target.el.querySelector('[class*="rowArea2"]'))
    fire(FIND.one(target.el, 'conversationDesc'))

    return { ok: true, name: target.name, total: rows.length, all: rows.map(r => r.name) }
  })()`)

  if (result.err) {
    if (result.err === 'not found') {
      throw new Error(`找不到会话「${uname}」，现有：${(result.available || []).join(', ')}`)
    }
    return false
  }

  await sleep(3000)
  if (await hasInput(b)) return true

  // 再点一次（第二下常有效）
  await b.eval(`(() => {
    const WANT = ${JSON.stringify(String(uname || ''))}
    let items = [...document.querySelectorAll('[class*="ConversationItemwrapper"]')]
    if (!items.length) return false
    const rows = items.map((el) => {
      const r = el.getBoundingClientRect()
      const nameEl = el.querySelector('[class*="ConversationItemtitle"]')
      return { el, y: Math.round(r.top), name: (nameEl?.innerText || '').trim() }
    }).filter(x => x.name).sort((a, b) => a.y - b.y)
    if (!rows.length) return false
    let t = rows[0]
    if (WANT) t = rows.find(r => r.name.includes(WANT)) || rows[0]
    t.el.click()
    return true
  })()`)
  await sleep(3000)

  return hasInput(b)
}

/**
 * 走接口读私信（**不依赖 DOM 结构**）。
 *
 * 原理：抖音自己请求 `imapi.douyin.com/v1/message/get_by_conversation` 拿消息，
 * 我们 hook 住 fetch/XHR 把响应截下来，再用 `lib/pb.mjs` 解 protobuf。
 *
 * 为什么比 DOM 稳：
 *   · 字段号是接口契约，抖音改版很少动；DOM 的 hash class 每次发版都可能变
 *   · 不受窗口尺寸影响（DOM 那套要求视口 ≥1800 宽，否则输入框跑出视口）
 *   · 消息顺序、发送者、时间戳都是结构化数据，不用从 innerText 里猜
 *
 * 代价：得先「触发」一次请求 —— 所以还是要调 `enterChat` 进会话。
 *       但那只用来**触发**，读数据完全不看 DOM。
 */
export async function readDMViaApi({ browser, uname = '', limit = 30, scrollBack = 0 }) {
  // ① hook 必须在位（首次或页面 reload 后会自动补上）
  if (!(await apiHookReady(browser))) {
    await apiInstallHook(browser)
    if (!(await apiHookReady(browser))) {
      return { ok: false, error: 'hook 装不上' }
    }
  }

  const hasPb = (list) => (list || []).some(
    (c) => c.kind === 'pb' && /get_by_conversation|get_user_message|message\/list/i.test(String(c.url)),
  )
  const cacheKey = uname || '*'

  // ② 先看 hook 里有没有**新抓到**的响应（轮询期间抖音会推新消息，偶尔会有）
  let captured = await apiDrain(browser)
  let parsed = null

  if (hasPb(captured)) {
    const me = await apiSelfInfo(browser).catch(() => ({ secUid: '' }))
    parsed = apiPickMessages(captured, { selfSecUid: me.secUid })
    const useful = filterUseful(parsed.messages)
    if (useful.length) apiCacheMessages(cacheKey, useful, { source: parsed.source })
  }

  // ③ 没抓到新的 → 用缓存。**这是常态**，因为抖音只在首次进会话时请求。
  if (!parsed?.messages?.length) {
    const cached = apiCachedMessages(cacheKey)
    if (cached?.messages?.length) {
      return shapeResult(cached.messages, limit, 'cache')
    }
  }

  // ④ 从没抓到过 → 进会话触发一次（会话没打开时抖音一定会请求）
  if (!parsed?.messages?.length) {
    // ⚡ 快路径：如果当前**已经在这个会话里**，就不用再 ensurePanel/enterChat ——
    //    那两步各要 2~3 秒的固定等待，轮询时白花。
    const already = await browser.eval(`(() => {
      const ta = document.querySelector('textarea')
      const ce = [...document.querySelectorAll('[contenteditable="true"]')].filter((x) => x.getBoundingClientRect().width > 100)
      return Boolean((ta && ta.getBoundingClientRect().width > 100) || ce.length)
    })()`).catch(() => false)

    if (!already) {
      const st = await ensurePanel(browser)
      if (!st.panelOpen && !st.inChat) {
        return { ok: false, error: st.error || '打不开私信面板（无法触发接口）' }
      }
      if (!st.inChat || uname) {
        const entered = await enterChat(browser, uname)
        if (!entered) return { ok: false, error: '进不去会话（无法触发接口）' }
      }
    } else if (uname) {
      // 已经在某个会话里，但不是目标好友 —— 切过去。切会话会触发新请求。
      await enterChat(browser, uname).catch(() => {})
    }

    for (let i = 0; i < Math.min(scrollBack, 5); i++) {
      await browser.eval(`(() => {
        let best = null
        for (const el of document.querySelectorAll('div')) {
          const s = getComputedStyle(el)
          if (!/auto|scroll/.test(s.overflowY)) continue
          if (el.scrollHeight <= el.clientHeight + 20) continue
          if (!best || el.scrollHeight > best.scrollHeight) best = el
        }
        if (best) best.scrollTop = Math.max(0, best.scrollTop - best.clientHeight * 2)
        return Boolean(best)
      })()`).catch(() => {})
      await sleep(1000)
    }
    await sleep(2000)
    captured = await apiDrain(browser)

    if (hasPb(captured)) {
      const me = await apiSelfInfo(browser).catch(() => ({ secUid: '' }))
      parsed = apiPickMessages(captured, { selfSecUid: me.secUid })
      const useful = filterUseful(parsed.messages)
    if (useful.length) apiCacheMessages(cacheKey, useful, { source: parsed.source })
    }
  }

  // ⑤ 还是没有 → reload 清缓存（**只在从没成功过时**做，慢但确定有效）
  if (!parsed?.messages?.length) {
    apiClearCache()
    await apiTriggerFetch(browser).catch(() => {})
    const st2 = await ensurePanel(browser)
    if (st2.panelOpen || st2.inChat) {
      await enterChat(browser, uname)
      await sleep(3500)
    }
    captured = await apiDrain(browser)
    if (hasPb(captured)) {
      const me = await apiSelfInfo(browser).catch(() => ({ secUid: '' }))
      parsed = apiPickMessages(captured, { selfSecUid: me.secUid })
      const useful = filterUseful(parsed.messages)
    if (useful.length) apiCacheMessages(cacheKey, useful, { source: parsed.source })
    }
  }

  if (!parsed?.messages?.length) {
    return { ok: false, error: parsed?.error || '接口里没解出消息' }
  }

  return shapeResult(parsed.messages, limit, 'api')
}

/** 把接口解出来的消息整理成和 DOM 路径一致的形状 */
function shapeResult(rawMessages, limit, via) {
  const msgs = filterUseful(rawMessages).map((m) => ({
    fromMe: m.fromMe === true,
    system: m.isSystem && !m.text,
    unsupported: false,
    isShare: Boolean(m.shareAweme) || m.kind === 8,
    text: m.text || m.tips || '',
    seq: m.seq,
    time: m.time,
    kind: m.kind,
  }))
  return {
    ok: true,
    messages: msgs.slice(-limit),
    total: msgs.length,
    inChat: true,
    via,
  }
}

/**
 * 只留下「有内容」的消息。
 *
 * ⚠️ 缓存也要用这个过滤 —— 否则缓存里塞一堆 kind=8 的空壳，
 *    `shapeResult` 过滤完就空了，表现为「缓存命中了但 0 条」。
 */
function filterUseful(rawMessages) {
  return (rawMessages || []).filter((m) => m.text || m.tips || m.shareAweme)
}

/** 聊天输入框出现了吗 */
async function hasInput(b) {
  return b.eval(`(() => {
    const ta = document.querySelector('textarea')
    const ce = [...document.querySelectorAll('[contenteditable="true"]')].filter(x => x.getBoundingClientRect().width > 100)
    return Boolean((ta && ta.getBoundingClientRect().width > 100) || ce.length)
  })()`)
}

/**
 * 读私信（进聊天界面，读 DOM）。
 * @param {object} p { browser, limit }
 */
/**
 * 读私信消息（带发送者标记）。
 *
 * ⭐ 判断"谁发的"用 class **`isFromMe`**（探针实测）：
 *    每条消息的外层容器是 `messageMessageBoxmessageBox`，
 *    内层 `messageMessageBoxcontentBox` 上如果是自己发的就带 `isFromMe`。
 *
 * ⚠️ **抖音是虚拟列表**：默认只渲染最近的一屏。想读更多历史必须往上滚。
 *    `scrollBack` 控制往上滚几次（每次约加载 20 条）。滚完再读。
 *
 * ⚠️ 分享卡片是 `MessageItemShareAwemecontainer`，文本只有作者名，没有正文。
 *
 * @param {object} p
 * @param {object} p.browser
 * @param {number} p.limit       最多返回多少条（默认 30）
 * @param {string} p.uname       指定会话（按好友名），空=最新的
 * @param {number} p.scrollBack  往上滚几次来加载历史（默认 0，不滚）
 */
export async function readDM({ browser, limit = 30, uname = '', scrollBack = 0 }) {
  // ── ① 先走接口（稳）──────────────────────────────────────────────
  //
  // 🔴 这是首选路径：读抖音自己的 `imapi.douyin.com/v1/message/get_by_conversation`
  //    响应，解 protobuf。**完全不依赖 DOM** —— 页面改版、窗口变窄都不影响。
  //
  //    流程：确保 hook 在位 → 进会话（触发请求）→ 从 hook 里取响应 → 解码。
  //    触发还是要进会话（DOM 操作），但**只用来触发**，读数据不靠它。
  //
  //    失败就落到下面的 DOM 路径（双保险）。
  const viaApi = await readDMViaApi({ browser, uname, limit, scrollBack }).catch((e) => ({
    ok: false,
    error: `接口路径出错：${e?.message || e}`,
  }))
  if (viaApi.ok) return viaApi

  // ── ② DOM 兜底（老路，脆但能用）──────────────────────────────────
  const st = await ensurePanel(browser)
  if (!st.panelOpen && !st.inChat) {
    return {
      ok: false,
      error: st.error || '打不开私信面板',
      debug: { vw: st.vw, vh: st.vh, hasMsgBtn: st.hasMsgBtn, panelRect: st.panelRect },
    }
  }

  // 指定了好友，或者还没进聊天 → 进会话
  if (!st.inChat || uname) {
    let entered = false
    try {
      entered = await enterChat(browser, uname)
    } catch (e) {
      return { ok: false, error: e.message, debug: st }
    }
    if (!entered) {
      return { ok: false, error: '进不去具体会话（点了但没出现输入框）', debug: st }
    }
  }

  // 往上滚加载历史
  if (scrollBack > 0) {
    for (let i = 0; i < scrollBack; i++) {
      const before = await browser.eval(`(() => {
        const FIND = ${pageFindHelper()}
        return FIND.messageBox().length
      })()`)
      await browser.eval(`(() => {
        // 找最大的可滚动容器（消息列表）
        let best = null
        let bestArea = 0
        for (const el of document.querySelectorAll('div')) {
          if (el.scrollHeight <= el.clientHeight + 20) continue
          const r = el.getBoundingClientRect()
          if (r.width < 200 || r.height < 150) continue
          const area = r.width * r.height
          if (area > bestArea) { bestArea = area; best = el }
        }
        if (best) {
          best.scrollTop = 0
          return { ok: true, h: best.clientHeight, sh: best.scrollHeight }
        }
        return { ok: false }
      })()`)
      await sleep(1500)
      const after = await browser.eval(`(() => {
        const FIND = ${pageFindHelper()}
        return FIND.messageBox().length
      })()`)
      if (after <= before) break   // 没加载出新东西，停
    }
  }

  // ⚠️ 页面里跑的 JS，用 String.raw 写（\n / \d 要原样进浏览器）
  const MSGS_JS = String.raw`(() => {
    const FIND = ${pageFindHelper()}

    // 找所有消息外层容器（走降级链）
    const all = FIND.messageBox()
    const boxes = all.filter((el) => {
      const cls = (el.className || '').toString()
      // 过滤掉同一批匹配里的内层节点 —— 只要「外层容器」
      if (cls.includes('selectableRow')) return false
      if (cls.includes('contentBox')) return false
      const r = el.getBoundingClientRect()
      return r.width > 100 && r.height > 20
    })

    // 时间和已读状态不算正文
    const isMeta = (s) => /^(\d+秒前|\d+分钟前|\d+小时前|\d+天前|刚刚|昨天|前天|\d{1,2}月\d{1,2}日)$/.test(s)
      || /^\d{1,2}:\d{2}$/.test(s)
      || s === '已读' || s === '未读'

    const out = []
    for (const box of boxes) {
      const t = (box.innerText || '').trim()
      if (!t) continue
      const r = box.getBoundingClientRect()

      // ⭐ 判断发送者 / 分享卡片（都走降级链）
      const fromMe = Boolean(FIND.one(box, 'fromMe'))
      const isShare = Boolean(FIND.one(box, 'shareCard'))

      // 清理文本：去掉零宽字符、时间和已读标记
      const lines = t.split(String.fromCharCode(10))
        .map((s) => s.replace(/\u200b/g, '').trim())
        .filter(Boolean)
        .filter((s) => !isMeta(s))

      const text = lines.join(' ').trim()
      if (!text) continue

      out.push({
        fromMe,
        isShare,
        text: text.slice(0, 500),
        // ⭐ y 坐标用于排序（DOM 顺序不可靠）
        y: Math.round(r.top),
      })
    }
    return out
  })()`

  const msgs = await browser.eval(MSGS_JS)

  if (!Array.isArray(msgs)) return { ok: false, error: '读不到消息列表', debug: st }

  // 去重（嵌套容器会重复）
  const seen = new Set()
  const uniq = msgs.filter((m) => {
    const k = (m.fromMe ? 'me' : 'peer') + '|' + m.text.slice(0, 40)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  // ⭐ 按 y 排序 = 视觉顺序（从上到下），最后一条就是最新的
  uniq.sort((a, b) => a.y - b.y)

  // 标记系统消息（不该触发回复）
  //
  // 🔴 除了「已互相关注」这类，还要拦两种：
  //    ① **「暂不支持该消息类型展示 请到抖音手机端查看」**
  //       —— 对方发的是网页端渲染不了的消息（语音、红包、某些卡片）。
  //       它不是对话内容，回它等于答非所问。
  //    ② **「[分享视频] xxx」** —— 分享卡片没有正文，也不该触发回复
  //       （分享由 digest 负责，聊天由 watch 负责，别串）。
  const SYS = new RegExp([
    '已互相关注',
    '可以开始聊天',
    '发布了新作品',
    '进入了直播间',
    '关注了你',
    '赞了你的',
    '系统消息',
    '撤回了一条消息',
    '暂不支持该消息类型展示',
    '请到抖音手机端查看',
    '消息已发出.*但被对方拒收',
    '对方开启了朋友验证',
  ].join('|'))

  for (const m of uniq) {
    m.system = !m.isShare && SYS.test(m.text)
    // 网页端读不到内容的卡片，单独标一下（给上层决定要不要提示用户）
    m.unsupported = /暂不支持该消息类型展示/.test(m.text)
    delete m.y
  }

  return {
    ok: true,
    messages: uniq.slice(-limit),
    total: uniq.length,
    inChat: true,
  }
}

/**
 * 发私信。
 * @param {object} p { browser, text, uname }
 */
export async function sendDM({ browser, text, uname = '' }) {
  const body = String(text || '').trim()
  if (!body) return { ok: false, error: '正文是空的' }

  const st = await ensurePanel(browser)
  if (!st.panelOpen && !st.inChat) return { ok: false, error: '打不开私信面板' }

  // 🔴 必须确认**进的是对的那个人**再打字。
  //    以前是 `if (!st.inChat) await enterChat(...)` —— 返回值直接丢掉了：
  //    enterChat 没进去 / 进错会话时照样往下走，消息就发给了上一个人。
  //    （表现：工具返回 ok:true，抖音里却查不到这条。）
  if (uname) {
    const ok = await enterChat(browser, uname)
    if (!ok) return { ok: false, error: `进不去「${uname}」的会话` }
    await sleep(600)
    // 再确认一次：现在打开的会话确实是这个人
    const cur = await currentPeer({ browser })
    if (cur.inChat && cur.name && !cur.name.includes(uname) && !uname.includes(cur.name)) {
      return { ok: false, error: `当前会话是「${cur.name}」，不是「${uname}」` }
    }
  } else if (!st.inChat) {
    const ok = await enterChat(browser, '')
    if (!ok) return { ok: false, error: '进不去会话' }
  }

  const focused = await browser.eval(`(() => {
    const ta = document.querySelector('textarea')
    const ce = [...document.querySelectorAll('[contenteditable="true"]')].find(x => x.getBoundingClientRect().width > 100)
    const el = (ta && ta.getBoundingClientRect().width > 100) ? ta : ce
    if (!el) return null
    el.focus()
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }
  })()`)
  if (!focused) return { ok: false, error: '找不到输入框' }

  // 点一下输入框，确保焦点
  //
  // 🔴 不能只靠 Input.dispatchMouseEvent —— 输入框可能**落在视口外**
  //    （实测：视口 1532 宽，聊天输入框在 x=1707，点不到，焦点留在 BODY 上）。
  //    `Input.insertText` 只往「当前焦点」打字，焦点在 BODY 上就等于什么都没打。
  //    ⇒ 先用 JS 直接 focus()，再用 CDP 打字的**双保险**。
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: focused.x, y: focused.y, button: 'left', clickCount: 1 }, browser.sessionId)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: focused.x, y: focused.y, button: 'left', clickCount: 1 }, browser.sessionId)
  await sleep(300)

  // JS 兜底：直接聚焦那个 contenteditable（不依赖坐标）
  const focusedByJs = await browser.eval(`(() => {
    const ce = [...document.querySelectorAll('[contenteditable="true"]')]
      .filter((x) => { const r = x.getBoundingClientRect(); return r.width > 50 && r.height > 10 })
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0]
    if (!ce) return false
    ce.focus()
    // 有些编辑器要在内部的可编辑节点上聚焦
    const inner = ce.querySelector('[contenteditable="true"]')
    if (inner && inner !== ce) inner.focus()
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(inner || ce)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
    return document.activeElement === ce || document.activeElement === inner || ce.contains(document.activeElement)
  })()`)
  await sleep(250)

  const READ_INPUT = `(() => {
    const ta = document.querySelector('textarea')
    const ce = [...document.querySelectorAll('[contenteditable="true"]')].find((x) => x.getBoundingClientRect().width > 100)
    const el = (ta && ta.getBoundingClientRect().width > 100) ? ta : ce
    return el ? String(el.value || el.innerText || '').replace(/\u200b/g, '').trim() : ''
  })()`

  await browser.send('Input.insertText', { text: body }, browser.sessionId)
  await sleep(900)

  let typed = await browser.eval(READ_INPUT)

  // 还是空的 ⇒ 用 JS 直接写进去（React 受控组件要走原生 setter + input 事件）
  if (!typed) {
    await browser.eval(`(() => {
      const ce = [...document.querySelectorAll('[contenteditable="true"]')]
        .filter((x) => { const r = x.getBoundingClientRect(); return r.width > 50 && r.height > 10 })
        .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0]
      if (!ce) return false
      ce.focus()
      // execCommand 会触发正常的 input 事件，React 能收到
      document.execCommand('insertText', false, ${JSON.stringify(body)})
      return true
    })()`)
    await sleep(700)
    typed = await browser.eval(READ_INPUT)
  }

  // 🔴 必须确认**打的正是要发的内容**。
  //    只看「输入框非空」不够：焦点没在输入框时 insertText 会打进别处，
  //    或者输入框里残留着上一次的字 —— 都会让后面「输入框空了 = 发送成功」变成假阳性。
  if (!typed) {
    return { ok: false, error: `输入没生效（焦点=${focusedByJs ? '已聚焦' : '聚焦失败'}，输入框仍为空）` }
  }
  if (!typed.includes(body.slice(0, 12))) {
    return { ok: false, error: `输入框里的内容不对：${JSON.stringify(typed.slice(0, 40))}` }
  }

  // Enter 发送
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, browser.sessionId)
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, browser.sessionId)
  await sleep(2500)

  const after = await browser.eval(READ_INPUT)
  if (after) return { ok: false, error: '输入框还有内容，可能没发出去' }

  // 🔴 真·验证：消息列表里必须出现这条内容。
  //    以前只判断「输入框空了」就返回 ok —— 结果出现过「返回 ok:true、抖音里却查不到」
  //    （Enter 没触发发送，或者消息还在发送中就被读走了）。
  //    这里读一次聊天区，确认正文确实在。
  const probe = body.slice(0, 20)
  for (let i = 0; i < 4; i++) {
    const seen = await browser.eval(`(() => {
      const FINDV = ${pageFindHelper()}
      const boxes = FINDV.messageBox()
      for (const b of boxes) {
        if (!FINDV.one(b, 'fromMe')) continue
        if ((b.innerText || '').includes(${JSON.stringify(probe)})) return true
      }
      return false
    })()`)
    if (seen) return { ok: true, verified: true }
    await sleep(1200)
  }

  // 没在列表里看到 —— 不假装成功
  return {
    ok: false,
    error: '发送后没在消息列表里看到这条内容（Enter 可能没触发发送）',
    sent: body.slice(0, 40),
  }
}

/** 登录态检查 */
export async function checkLogin(browser) {
  const ck = await browser.cookies(['https://www.douyin.com/', 'https://www.douyin.com/user/self'])
  const names = ck.map((c) => c.name)
  // ⚠️ 只认 sessionid / sessionid_ss —— passport_csrf_token 是访客 cookie
  const logged = names.includes('sessionid') || names.includes('sessionid_ss')
  return {
    loggedIn: logged,
    cookies: names.length,
    detail: logged ? '已登录' : '未登录（passport_csrf_token 是访客 cookie，不算登录）',
  }
}

/* ── 会话列表 ──────────────────────────────────────────────────────── */

/**
 * 列出私信会话（会话名 / 时间 / 预览 / 未读标记）。
 *
 * ⭐ 会话项 class：`conversationConversationItemwrapper`
 *    ├ `conversationConversationItemtitle`    好友名
 *    ├ `ConversationItemTagNextToTitlewrapper` 时间
 *    └ `ConversationItemDescwrapper`          消息预览
 *
 * ⚠️ 这一步**只读不点**：不进入任何会话，所以不会打扰对方的在线状态，
 *    也不会把自己这边的"正在输入"暴露出去。
 *
 * @param {object} p { browser, limit }
 */
export async function dmList({ browser, limit = 40 }) {
  const st = await ensurePanel(browser)
  if (!st.panelOpen && !st.inChat) {
    return {
      ok: false,
      error: st.error || '打不开私信面板',
      debug: { vw: st.vw, vh: st.vh, hasMsgBtn: st.hasMsgBtn },
    }
  }

  // ⚠️ 这段是**页面里跑的 JS**，用 String.raw 写：里面的 \n / \d / \s 要原样进浏览器，
  //    不能用普通模板字符串（那会把 \n 变成真换行，把整个表达式弄坏）。
  //
  // ⭐ 选择器全部走 selectors.mjs 的降级链（data-e2e → 语义 class → 结构兜底），
  //    抖音改版把某条路径打挂时，后面的还能顶。
  const ROWS_JS = String.raw`(() => {
    const FIND = ${pageFindHelper()}
    let items = FIND.conversationItem()

    if (!items.length) {
      // 最后一层兜底：按尺寸 + 时间关键词找
      const KW = ['分钟前', '小时前', '昨天', '刚刚']
      items = [...document.querySelectorAll('div')].filter((el) => {
        const r = el.getBoundingClientRect()
        if (r.width < 250 || r.width > 450) return false
        if (r.height < 50 || r.height > 120) return false
        const t = el.innerText || ''
        return KW.some((k) => t.indexOf(k) >= 0)
      })
    }
    const isNoise = (s) => /^\d{1,3}$/.test(s)
      || /^\d{1,2}:\d{2}$/.test(s)
      || /^(昨天|刚刚|\d+分钟前|\d+小时前|\d+月\d+日)$/.test(s)

    const out = []
    for (const el of items) {
      const r = el.getBoundingClientRect()
      // 只认真的渲染出来的会话项（DOM 里常有 0×0 的隐藏副本）
      if (r.width < 100 || r.height < 20) continue
      const nameEl = FIND.one(el, 'conversationTitle')
      const timeEl = FIND.one(el, 'conversationTime')
      const descEl = FIND.one(el, 'conversationDesc')
      const raw = (el.innerText || '').trim()

      // 🔴 名字要剥掉未读数和时间：
      //    innerText 长这样 —— 「好友名 / 3 / 03:27」，
      //    直接把整串当名字，后面按名字找人就会失配。
      const title = (nameEl?.innerText || '').trim()
      const parts = (title || raw).split('\n').map((s) => s.trim()).filter((s) => s && !isNoise(s))
      const name = (parts[0] || '').replace(/\s*\d{1,3}\s*$/, '').trim()
      if (!name) continue

      const badge = FIND.one(el, 'unreadBadge')
      out.push({
        name,
        time: (timeEl?.innerText || '').trim(),
        preview: (descEl?.innerText || '').trim().split('\n').join(' ').slice(0, 200),
        unread: Boolean(badge),
        y: Math.round(r.top),
      })
    }
    return out
  })()`

  const rows = await browser.eval(ROWS_JS)

  if (!Array.isArray(rows)) return { ok: false, error: '读不到会话列表' }

  const seen = new Set()
  const uniq = rows
    .filter((x) => (seen.has(x.name) ? false : (seen.add(x.name), true)))
    .sort((a, b) => a.y - b.y)

  return { ok: true, conversations: uniq.slice(0, limit), total: uniq.length }
}

/**
 * 当前打开的会话是哪个好友（进聊天时才知道）。
 *
 * 🔴 抖音的聊天面板**没有独立的会话头元素**（实测：右侧只有「消息」标题栏，
 *    好友名不在里面）。真正的信号是**左侧会话列表里被选中的那一项** ——
 *    选中项带 `active` / `selected` 之类的 class。
 *
 * ⚠️ 千万别用「尺寸 + 文字长度」去猜：那样会抓到左侧导航的「精选」，
 *    或者聊天区里的消息正文（实测抓到过「刚才那个视频讲了啥」）。
 *
 * @param {object} p { browser }
 */
export async function currentPeer({ browser }) {
  const CUR_JS = String.raw`(() => {
    const FIND = ${pageFindHelper()}
    const ta = document.querySelector('textarea')
    const ce = FIND.chatInput().filter((x) => x.getBoundingClientRect().width > 100)
    const inChat = Boolean((ta && ta.getBoundingClientRect().width > 100) || ce.length)
    if (!inChat) return { inChat: false, name: '' }

    const isNoise = (s) => /^\d{1,3}$/.test(s)
      || /^\d{1,2}:\d{2}$/.test(s)
      || /^(昨天|刚刚|\d+分钟前|\d+小时前|\d+月\d+日)$/.test(s)

    const nameOf = (item) => {
      const title = FIND.one(item, 'conversationTitle')
      const parts = ((title?.innerText || '').trim() || (item.innerText || '').trim())
        .split('\n').map((s) => s.trim()).filter((s) => s && !isNoise(s))
      return (parts[0] || '').replace(/\s*\d{1,3}\s*$/, '').trim()
    }

    // ① 选中项：class 里带 active / selected / current 的会话项
    const items = FIND.conversationItem()
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 100 && r.height > 20 })
    for (const el of items) {
      const cls = String(el.className || '')
      // 选中态可能挂在会话项自己身上，也可能挂在它的子/父节点上
      const marks = [el, el.parentElement, el.firstElementChild].filter(Boolean)
      for (const m of marks) {
        const c = String(m.className || '')
        if (/\b(active|selected|current|checked|isActive)\b/i.test(c) || /active|selected/i.test(c)) {
          const name = nameOf(el)
          if (name) return { inChat: true, name, via: 'active-item' }
        }
      }
    }

    // ② 兜底：聊天面板正上方那个会话项（视觉上最靠上、且在列表里）
    if (items.length) {
      items.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      const name = nameOf(items[0])
      if (name) return { inChat: true, name, via: 'first-item' }
    }

    return { inChat: true, name: '', via: 'none' }
  })()`
  const r = await browser.eval(CUR_JS)
  return r || { inChat: false, name: '' }
}

export { ensurePanel, enterChat }

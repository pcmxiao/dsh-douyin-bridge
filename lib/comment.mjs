/**
 * lib/comment.mjs —— 视频评论：发评论 / 分享评论
 * ============================================================================
 * 抖音网页版评论区结构（2026-10 实测）：
 *
 *   视频页  https://www.douyin.com/?modal_id=<aweme_id>
 *     [data-e2e="feed-comment-icon"]   右栏评论按钮（点了才展开评论区）
 *     [data-e2e="comment-list"]        评论列表
 *       [data-e2e="comment-item"]      一条评论
 *         .comment-item-stats-container  「96 分享 回复」
 *           └─ 文字为「分享」的子节点     ← **分享评论的入口**
 *         [data-e2e="video-comment-more"] 「···」
 *     .comment-input-inner-container   评论输入框
 *       └─ .richtext-container → .DraftEditor-root
 *            └─ .public-DraftEditor-content[contenteditable=true]  ← 编辑器（聚焦后才挂上）
 *       .commentInput-right-ct          右侧按钮区
 *         ├─ <input type=file>  贴图
 *         ├─ <span><svg>        @ 提及
 *         ├─ <span><svg>        表情
 *         └─ <span><svg path d="M17.5 30C23.851 30...">  ← **发送箭头（发布）**
 *
 *   点评论的「分享」后，该评论下面会展开一行「分享给朋友」：
 *     「分享给朋友  <好友A> <数字> 分享  <好友B> 分享  暂时没有更多了」
 *
 * 🔴 四条血泪教训（都是实测踩出来的）：
 *
 *   1. **打开视频有三种方式，任意一种都会被风控打断**，必须多策略 + 轮询：
 *        a) `https://www.douyin.com/?modal_id=<id>`  ← 最稳，URL 不会被换
 *        b) `https://www.douyin.com/video/<id>`        ← 有时被重定向到 /jingxuan
 *        c) 搜索结果页点卡片                            ← 弹层，URL 稳定
 *      打开后如果评论框没出现，点 `[data-e2e="feed-comment-icon"]` 展开评论区。
 *
 *   2. **不能用真实鼠标点评论区的按钮**。
 *      评论区是虚拟列表，滚动后元素位置会变；用旧坐标点下去会
 *      穿透到背后的信息流 ⇒ 页面被弹回精选流（实测）。
 *      ⇒ 一律用 JS `element.click()`（不依赖坐标）。
 *      （例外：视频页的「评论」图标和「消息」入口必须用真实鼠标。）
 *
 *   3. **评论框是 Draft.js 富文本**，不是 textarea。
 *      - 编辑器**聚焦之后才挂上来**，没点过就只有一个占位 span；
 *      - 必须**先滚动进视口**（视频页的评论框在 y≈877，视口只有 791px）；
 *      - `document.execCommand('insertText')` 文字进去了但 Draft.js 的
 *        onChange 不触发 ⇒ 发布按钮不亮 ⇒ 要用 CDP 的 `Input.insertText`。
 *
 *   4. **发评论会被抖音要求短信验证码**（实测弹「接收短信验证码」）。
 *      这是账号级的一次性人机验证，代码绕不过去；
 *      工具要把这个状态如实报出去，让人去手机上确认一次。
 *
 * @module lib/comment
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 评论区输入框 / 列表的稳定选择器 */
export const SEL = {
  input: '.comment-input-inner-container',
  list: '[data-e2e="comment-list"]',
  item: '[data-e2e="comment-item"]',
  stats: '.comment-item-stats-container',
  more: '[data-e2e="video-comment-more"]',
  right: '.commentInput-right-ct',
  editor: '.public-DraftEditor-content[contenteditable="true"]',
  commentBtn: '[data-e2e="feed-comment-icon"]',
}

/** 发送箭头的 svg path 特征（和私信的发送按钮同一枚图标） */
const SEND_PATH = 'M17.5 30C23.851 30'

// ─────────────────────────────────────────────────────────────
// 打开视频页
// ─────────────────────────────────────────────────────────────

/** 策略 a：根地址 + modal_id */
async function openViaModalId(browser, id) {
  await browser.goto(`https://www.douyin.com/?modal_id=${id}`, { settleMs: 8000 })
}

/** 策略 b：直链视频页 */
async function openViaVideoPage(browser, id) {
  await browser.goto(`https://www.douyin.com/video/${id}`, { settleMs: 8000 })
}

/** 策略 c：搜索结果页点卡片 */
async function openViaSearchCard(browser, id) {
  await browser.goto('https://www.douyin.com/jingxuan', { settleMs: 8000 })
  await sleep(1500)
  const hit = await browser.eval(`(() => {
    const a = document.querySelector('a[href*="/video/${id}"]')
    if (!a) return null
    const r = a.getBoundingClientRect()
    if (!r.width || !r.height) return null
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`).catch(() => null)
  if (!hit) return false
  for (const type of ['mousePressed', 'mouseReleased']) {
    await browser.send('Input.dispatchMouseEvent', {
      type, x: hit.x, y: hit.y, button: 'left', clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0,
    }, browser.sessionId)
  }
  await sleep(2500)
  return true
}

/** 评论区是否就绪 */
async function commentAreaState(browser) {
  return browser.eval(`(() => {
    const box = document.querySelector('${SEL.input}')
    const item = document.querySelector('${SEL.item}')
    const btn = document.querySelector('${SEL.commentBtn}')
    const r = box ? box.getBoundingClientRect() : null
    return {
      url: location.href,
      hasBox: Boolean(box),
      hasItem: Boolean(item),
      hasBtn: Boolean(btn),
      boxW: r ? Math.round(r.width) : 0,
      bodyLen: document.body ? document.body.innerText.length : 0,
    }
  })()`).catch(() => null)
}

/** 点右栏的评论图标，把评论区展开（必须真实鼠标） */
async function clickCommentIcon(browser) {
  const p = await browser.eval(`(() => {
    const el = document.querySelector('${SEL.commentBtn}')
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return null
    if (r.top < 0 || r.bottom > innerHeight) return null
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`).catch(() => null)
  if (!p) return false
  for (const type of ['mousePressed', 'mouseReleased']) {
    await browser.send('Input.dispatchMouseEvent', {
      type, x: p.x, y: p.y, button: 'left', clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0,
    }, browser.sessionId)
  }
  await sleep(1800)
  return true
}

/**
 * 打开视频页并等到评论区就绪。
 *
 * 三种打开方式轮着试（风控会随机打断其中任意一种），
 * 评论区没自动展开就点右栏的评论图标。
 *
 * @param {object} p
 * @param {object} p.browser
 * @param {string[]} p.ids  候选视频 id（按顺序试）
 * @param {number} [p.timeoutMs]
 * @returns {Promise<{ok:boolean, id?:string, error?:string, code?:string, state?:object}>}
 */
export async function openVideoPage({ browser, ids = [], timeoutMs = 20000, prefer = 'modal' }) {
  const list = (ids || []).map(String).filter(Boolean)
  if (!list.length) return { ok: false, error: '没有视频 id', code: 'NO_VIDEO' }

  // prefer='video' → 分享评论要走这个布局（实测只有它能展开「分享给朋友」）
  //   这个布局被风控重定向的概率不低 ⇒ 同一个 id 多试几次
  const strategies = prefer === 'video'
    ? [openViaVideoPage, openViaVideoPage, openViaVideoPage, openViaModalId]
    : [openViaModalId, openViaVideoPage, openViaSearchCard]

  for (const id of list.slice(0, 3)) {
    for (const open of strategies) {
      try { await open(browser, id) } catch { continue }

      const deadline = Date.now() + timeoutMs
      let st = null
      let triedBtn = false
      while (Date.now() < deadline) {
        st = await commentAreaState(browser)
        if (st?.hasBox && st?.hasItem) break
        // 被重定向到 /jingxuan 了 —— 立刻换策略，别死等
        if (prefer === 'video' && st && !/\/video\//.test(st.url || '')) break
        if (st?.hasBtn && !triedBtn) {
          if (await clickCommentIcon(browser)) { triedBtn = true; continue }
        }
        await sleep(1000)
      }
      if (st?.hasBox && st?.hasItem) {
        // prefer='video' 时必须是 /video/ 布局 —— 分享评论只在这个布局下能展开
        const isVideoLayout = /\/video\//.test(st.url || '')
        if (prefer === 'video' && !isVideoLayout) continue
        await closeIMPanel(browser).catch(() => {})
        return { ok: true, id, state: st, layout: isVideoLayout ? 'video' : 'modal' }
      }
    }
  }
  return {
    ok: false,
    code: 'VIDEO_UNAVAILABLE',
    error: '视频页没打开评论区（视频不可见，或被风控拦了）',
  }
}

// ─────────────────────────────────────────────────────────────
// 输入
// ─────────────────────────────────────────────────────────────

/**
 * 往评论框里打字。
 *
 * 详见文件头的教训 3：必须滚动进视口 → 真实鼠标点一下聚焦
 * → 等 Draft.js 的编辑器挂上来 → 用 CDP `Input.insertText` 插文本。
 *
 * @param {object} browser
 * @param {string} text
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
export async function typeComment(browser, text) {
  const t = String(text || '').trim()
  if (!t) return { ok: false, error: 'comment text is empty' }

  const inView = await browser.eval(`(() => {
    const root = document.querySelector('${SEL.input}')
    if (!root) return { ok: false, error: 'comment input box not found' }
    root.scrollIntoView({ block: 'center' })
    return { ok: true }
  })()`).catch(() => ({ ok: false, error: 'comment input box not found' }))
  if (!inView.ok) return inView
  await sleep(500)

  const pos = await browser.eval(`(() => {
    const root = document.querySelector('${SEL.input}')
    if (!root) return null
    const r = root.getBoundingClientRect()
    if (!r.width || !r.height) return null
    if (r.top < 0 || r.bottom > innerHeight) return null
    return { x: Math.round(r.left + Math.min(30, r.width / 2)), y: Math.round(r.top + r.height / 2) }
  })()`).catch(() => null)
  if (!pos) return { ok: false, error: 'comment input box is not on screen' }

  for (const type of ['mousePressed', 'mouseReleased']) {
    await browser.send('Input.dispatchMouseEvent', {
      type, x: pos.x, y: pos.y, button: 'left', clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0,
    }, browser.sessionId)
  }

  let ready = false
  for (let i = 0; i < 10; i++) {
    await sleep(300)
    const has = await browser.eval(`Boolean(document.querySelector('${SEL.editor}'))`).catch(() => false)
    if (has) { ready = true; break }
  }
  if (!ready) return { ok: false, error: 'editor never showed up after focusing the box' }

  // 🔴 编辑器挂上来 ≠ 已经拿到焦点。
  //    Draft.js 是「先渲染、后 focus」，焦点要再等一拍；
  //    焦点没到位时 Input.insertText 会打进空气里 —— 文字不进框，React 状态也不动。
  let focused = false
  for (let i = 0; i < 12; i++) {
    const f = await browser.eval(`(() => {
      const ed = document.querySelector('${SEL.editor}')
      if (!ed) return false
      const a = document.activeElement
      return Boolean(a && (a === ed || ed.contains(a) || (a.className && String(a.className).includes('DraftEditor'))))
    })()`).catch(() => false)
    if (f) { focused = true; break }
    await sleep(200)
  }
  if (!focused) {
    // 兜底：直接 focus 一下编辑器
    await browser.eval(`(() => {
      const ed = document.querySelector('${SEL.editor}')
      if (ed) ed.focus()
      return true
    })()`).catch(() => {})
    await sleep(300)
  }

  try {
    await browser.send('Input.insertText', { text: t }, browser.sessionId)
  } catch {
    await browser.eval(`(() => {
      const ed = document.querySelector('${SEL.editor}')
      if (!ed) return false
      ed.focus()
      document.execCommand('insertText', false, ${JSON.stringify(t)})
      return true
    })()`)
  }
  await sleep(1000)

  const after = await browser.eval(`(() => {
    const ed = document.querySelector('${SEL.editor}')
    return { text: ed ? ((ed.innerText || ed.textContent || '').trim()) : '' }
  })()`).catch(() => ({ text: '' }))

  if (!after.text) return { ok: false, error: 'text did not reach the editor' }
  return { ok: true, text: after.text }
}

// ─────────────────────────────────────────────────────────────
// 验证码弹窗
// ─────────────────────────────────────────────────────────────

/**
 * 抖音在发评论前可能要人机验证（实测：短信验证码）。
 *
 * @param {object} browser
 * @returns {Promise<{need:boolean, kind?:string, phone?:string, text?:string}>}
 */
export async function detectVerification(browser) {
  return browser.eval(`(() => {
    const t = document.body ? document.body.innerText : ''
    const sms = /接收短信验证码|获取验证码|请输入验证码/.test(t)
    const captcha = /滑块验证|安全验证|请完成验证|拖动滑块/.test(t)
    if (!sms && !captcha) return { need: false }
    const m = /(\\d{3}\\*{2,}\\d{2,})/.exec(t)
    return {
      need: true,
      kind: sms ? 'sms' : 'captcha',
      phone: m ? m[1] : '',
      text: t.split('\\n').filter(x => /验证码|验证/.test(x)).slice(0, 3).join(' | '),
    }
  })()`).catch(() => ({ need: false }))
}

// ─────────────────────────────────────────────────────────────
// 发布
// ─────────────────────────────────────────────────────────────

/**
 * 点「发布」。
 *
 * 右侧那排按钮**全是纯图标，没有「发布」二字**，按文字搜永远搜不到。
 * ⇒ 认 path 的 d 属性：发送箭头的 d 以 `M17.5 30C23.851 30` 开头。
 *
 * @param {object} browser
 * @returns {Promise<{ok:boolean, via?:string, verify?:object, error?:string, seen?:Array}>}
 */
export async function clickPublish(browser) {
  const FIND = `(() => {
    const right = document.querySelector('${SEL.right}')
    const scope = right || document.querySelector('${SEL.input}')?.parentElement
    if (!scope) return { found: false, seen: [] }
    const byText = [...scope.querySelectorAll('button, [role="button"], span, div')]
      .filter(el => {
        const t = (el.innerText || '').trim()
        if (t !== '发布' && t !== '发表' && t !== '发送') return false
        const r = el.getBoundingClientRect()
        return r.width > 10 && r.height > 10
      })
    const byIcon = [...scope.querySelectorAll('svg path')]
      .filter(p => (p.getAttribute('d') || '').startsWith('${SEND_PATH}'))
      .map(p => p.closest('span') || p.closest('button') || p)
    const el = (byText[byText.length - 1] || byIcon[0]) || null
    const seen = [...scope.querySelectorAll('span, svg, button')].slice(0, 10).map(s => ({
      tag: s.tagName.toLowerCase(),
      cls: String(s.className?.baseVal ?? s.className ?? '').slice(0, 34),
      txt: (s.innerText || '').trim().slice(0, 8),
      isSend: Boolean(s.querySelector?.('path')?.getAttribute?.('d')?.startsWith('${SEND_PATH}')),
    }))
    return el ? { found: true, txt: (el.innerText || '').trim(), via: byText.length ? 'text' : 'icon', seen } : { found: false, seen }
  })()`

  for (let i = 0; i < 8; i++) {
    const r = await browser.eval(FIND).catch(() => null)
    if (r?.found) {
      const clicked = await browser.eval(`(() => {
        const right = document.querySelector('${SEL.right}')
        const scope = right || document.querySelector('${SEL.input}')?.parentElement
        if (!scope) return false
        const byText = [...scope.querySelectorAll('button, [role="button"], span, div')]
          .filter(el => {
            const t = (el.innerText || '').trim()
            if (t !== '发布' && t !== '发表' && t !== '发送') return false
            const r = el.getBoundingClientRect()
            return r.width > 10 && r.height > 10
          })
        const byIcon = [...scope.querySelectorAll('svg path')]
          .filter(p => (p.getAttribute('d') || '').startsWith('${SEND_PATH}'))
          .map(p => p.closest('span') || p.closest('button') || p)
        const el = (byText[byText.length - 1] || byIcon[0]) || null
        if (!el) return false
        el.click()
        return true
      })()`)
      if (clicked) {
        await sleep(2000)
        const verify = await detectVerification(browser)
        if (verify.need) return { ok: false, code: 'NEEDS_VERIFY', verify }
        const cleared = await browser.eval(`(() => {
          const ed = document.querySelector('${SEL.editor}')
          return ed ? (ed.innerText || '').trim() : ''
        })()`).catch(() => '')
        if (!cleared) return { ok: true, via: `js-click-${r.via}` }
      }
    }
    await sleep(700)
  }

  const last = await browser.eval(FIND).catch(() => null)
  const verify = await detectVerification(browser)
  if (verify.need) return { ok: false, code: 'NEEDS_VERIFY', verify }
  return {
    ok: false,
    error: 'publish button not found (it is an icon-only button in .commentInput-right-ct)',
    seen: last?.seen || [],
  }
}

// ─────────────────────────────────────────────────────────────
// 发评论
// ─────────────────────────────────────────────────────────────

/**
 * 列出视频页上的评论（给「分享评论」挑目标用）。
 *
 * @param {object} browser
 * @returns {Promise<Array<{i:number, author:string, text:string, hasShare:boolean}>>}
 */
export async function listComments(browser) {
  return browser.eval(`(() => {
    const items = [...document.querySelectorAll('${SEL.item}')]
    return items.map((el, i) => {
      const stats = el.querySelector('${SEL.stats}')
      const shareLeaf = stats
        ? [...stats.querySelectorAll('*')].find(x => (x.innerText || '').trim() === '分享')
        : null
      const nameEl = el.querySelector('[class*="name"], [class*="nickname"]')
      const lines = (el.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean)
      return {
        i,
        author: nameEl ? (nameEl.innerText || '').trim() : (lines[0] || '').slice(0, 20),
        text: (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 120),
        hasShare: Boolean(shareLeaf),
      }
    })
  })()`).catch(() => [])
}

/**
 * 发一条评论。
 *
 * @param {object} p
 * @param {object} p.browser
 * @param {string} p.id    视频 id
 * @param {string} p.text  评论内容
 * @param {boolean} [p.dryRun]  只打字不发布
 * @returns {Promise<{ok:boolean, posted?:boolean, comment?:string, error?:string, code?:string}>}
 */
export async function postComment({ browser, id, text, dryRun = false }) {
  const page = await openVideoPage({ browser, ids: [id] })
  if (!page.ok) return page

  const typed = await typeComment(browser, text)
  if (!typed.ok) return { ok: false, error: typed.error || '打字失败', code: 'TYPE_FAILED' }
  if (dryRun) return { ok: true, typed: typed.text, posted: false }

  const pub = await clickPublish(browser)
  if (!pub.ok) {
    if (pub.code === 'NEEDS_VERIFY') {
      return {
        ok: false,
        code: 'NEEDS_VERIFY',
        error: '抖音要求人机验证：' + (pub.verify?.text || '短信验证码'),
        verify: pub.verify,
        typed: typed.text,
      }
    }
    return { ok: false, error: pub.error, code: 'PUBLISH_FAILED', typed: typed.text }
  }

  // 等评论出现在列表里
  const needle = String(text).trim().slice(0, 12)
  for (let i = 0; i < 15; i++) {
    await sleep(1000)
    const hit = await browser.eval(`(() => {
      const items = [...document.querySelectorAll('${SEL.item}')]
      const el = items.find(x => (x.innerText || '').includes(${JSON.stringify(needle)}))
      return el ? (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 120) : ''
    })()`).catch(() => '')
    if (hit) return { ok: true, posted: true, via: pub.via, comment: hit }
  }
  return {
    ok: false,
    code: 'VERIFY_FAILED',
    error: '点了发布，但评论列表里没找到刚发的内容（可能被折叠或审核）',
    typed: typed.text,
  }
}

// ─────────────────────────────────────────────────────────────
// 分享评论
// ─────────────────────────────────────────────────────────────

/**
 * 点某条评论的「分享」，展开「分享给朋友」那一行。
 *
 * 🔴 用 JS `element.click()`，不用坐标：评论区是虚拟列表，滚动后坐标会失效。
 *
 * @param {object} browser
 * @param {number} index  评论序号（listComments 的 i）
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function openSharePanel(browser, index = 0) {
  const r = await browser.eval(`(() => {
    const items = [...document.querySelectorAll('${SEL.item}')]
    const el = items[${Number(index) || 0}]
    if (!el) return { ok: false, error: 'comment #' + (${Number(index) || 0}) + ' not found' }
    const stats = el.querySelector('${SEL.stats}')
    if (!stats) return { ok: false, error: 'this comment has no action row' }
    const leaf = [...stats.querySelectorAll('*')].find(x => (x.innerText || '').trim() === '分享')
    if (!leaf) return { ok: false, error: 'this comment has no share button' }
    leaf.click()
    return { ok: true, via: 'js-click' }
  })()`)
  if (!r?.ok) return r
  await sleep(2500)
  return { ok: true }
}

/**
 * 「分享给朋友」那一行里，每个好友 chip 的结构。
 *
 * @param {object} browser
 * @returns {Promise<Array<{name:string, txt:string, hasShare:boolean, w:number, h:number}>>}
 */
export async function listShareTargets(browser) {
  return browser.eval(`(() => {
    const label = [...document.querySelectorAll('div, span')]
      .find(el => (el.innerText || '').trim() === '分享给朋友' && el.children.length === 0)
    if (!label) return []
    // 往上找到装得下标题 + 好友 chip 的那个容器
    let box = label.parentElement
    while (box && box.children.length < 2) box = box.parentElement
    if (!box) return []
    const out = []
    for (const chip of box.children) {
      const t = (chip.innerText || '').trim().replace(/\\s+/g, ' ')
      if (!t || t === '分享给朋友') continue
      const shareLeaf = [...chip.querySelectorAll('*')].find(x => (x.innerText || '').trim() === '分享')
      const m = t.match(/^(.*?)(?:\\s+(\\d+))?\\s*分享\\s*$/)
      out.push({
        name: m ? m[1].trim() : t,
        count: m && m[2] ? m[2] : '',
        txt: t,
        hasShare: Boolean(shareLeaf),
      })
    }
    return out
  })()`).catch(() => [])
}

/**
 * 分享一条评论给某个好友。
 *
 * 流程：点评论的「分享」→ 展开「分享给朋友」→ 点该好友 chip 上的「分享」。
 *
 * 🔴 **必须用 `/video/<id>` 布局**（实测）：
 *    沉浸式浮层（`?modal_id=`）里点「分享」五种方式都点不开这一行；
 *    只有视频页布局能展开。所以这里 `prefer: 'video'`。
 *
 * @param {object} p
 * @param {object} p.browser
 * @param {string} p.id       视频 id
 * @param {string} p.comment  评论内容片段（用来定位是哪条评论）
 * @param {string} p.to       好友昵称
 * @param {number} [p.index]  直接给评论序号（比 comment 更稳）
 * @param {boolean} [p.dryRun]
 * @returns {Promise<{ok:boolean, sent?:boolean, error?:string, code?:string}>}
 */
export async function shareComment({ browser, id, comment = '', to = '', index = -1, dryRun = false }) {
  const page = await openVideoPage({ browser, ids: [id], prefer: 'video' })
  if (!page.ok) return page

  // 定位评论
  let idx = Number(index)
  if (idx < 0) {
    const list = await listComments(browser)
    if (!list.length) return { ok: false, error: '这个视频页上没读到评论', code: 'NO_COMMENTS' }
    const needle = String(comment).trim()
    idx = list.findIndex(c => needle && c.text.includes(needle))
    if (idx < 0) idx = 0
  }

  // 展开「分享给朋友」那一行 —— 偶尔第一次点不开，重试两次
  let targets = []
  for (let attempt = 0; attempt < 3 && !targets.length; attempt++) {
    const opened = await openSharePanel(browser, idx)
    if (!opened.ok) return { ok: false, error: opened.error, code: 'NO_SHARE' }
    targets = await listShareTargets(browser)
    if (!targets.length) await sleep(1200)
  }
  if (!targets.length) return { ok: false, error: '「分享给朋友」没展开出来', code: 'NO_TARGETS' }

  const want = String(to).trim()
  const hit = want
    ? targets.find(t => t.name === want || t.name.includes(want) || t.txt.startsWith(want))
    : targets[0]
  if (!hit) {
    return {
      ok: false,
      code: 'NO_FRIEND',
      error: `「分享给朋友」里没有 ${want}`,
      targets: targets.map(t => t.name),
    }
  }
  if (dryRun) return { ok: true, sent: false, target: hit.name, targets: targets.map(t => t.name) }

  const clicked = await browser.eval(`(() => {
    const label = [...document.querySelectorAll('div, span')]
      .find(el => (el.innerText || '').trim() === '分享给朋友' && el.children.length === 0)
    if (!label) return false
    let box = label.parentElement
    while (box && box.children.length < 2) box = box.parentElement
    if (!box) return false
    for (const chip of box.children) {
      const t = (chip.innerText || '').trim().replace(/\\s+/g, ' ')
      if (!t || t === '分享给朋友') continue
      const m = t.match(/^(.*?)(?:\\s+(\\d+))?\\s*分享\\s*$/)
      const name = m ? m[1].trim() : t
      if (name !== ${JSON.stringify(hit.name)} && !name.includes(${JSON.stringify(want || hit.name)})) continue
      const leaf = [...chip.querySelectorAll('*')].find(x => (x.innerText || '').trim() === '分享')
      if (!leaf) continue
      leaf.click()
      return true
    }
    return false
  })()`)
  if (!clicked) return { ok: false, error: '点了「分享给朋友」里的好友，但没点上', code: 'CLICK_FAILED' }

  await sleep(2500)
  const verify = await detectVerification(browser)
  if (verify.need) {
    return { ok: false, code: 'NEEDS_VERIFY', error: '抖音要求人机验证：' + (verify.text || ''), verify }
  }
  return { ok: true, sent: true, target: hit.name }
}

// ─────────────────────────────────────────────────────────────
// 私信面板
// ─────────────────────────────────────────────────────────────

/**
 * 把私信面板关掉。
 *
 * 为什么要专门关：抖音的「消息」面板是全局浮层，会一直挂在右边
 * 抢走 ~336px，把评论输入框挤出屏幕，后面所有坐标都算错。
 *
 * 🔴 用**真实鼠标**点 `im-entry`：这个入口的点击必须走真实输入通道，
 *    JS `.click()` 点了没反应（见 douyin.mjs 的 ensurePanel 注释）。
 *
 * @param {object} browser
 * @returns {Promise<boolean>} 面板现在是不是关着的
 */
export async function closeIMPanel(browser) {
  const st = await browser.eval(`(() => {
    const dlg = document.querySelector('[data-e2e="im-dialog"]')
    if (!dlg) return { open: false, entry: null }
    let n = dlg, hidden = false
    for (let i = 0; i < 8 && n; i++) {
      if (getComputedStyle(n).display === 'none') { hidden = true; break }
      n = n.parentElement
    }
    const el = document.querySelector('[data-e2e="im-entry"]')
    const r = el ? el.getBoundingClientRect() : null
    return {
      open: !hidden,
      entry: r && r.width ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null,
    }
  })()`).catch(() => ({ open: false, entry: null }))

  if (!st.open) return true
  if (!st.entry) return false
  for (const type of ['mousePressed', 'mouseReleased']) {
    await browser.send('Input.dispatchMouseEvent', {
      type, x: st.entry.x, y: st.entry.y, button: 'left', clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0,
    }, browser.sessionId)
  }
  await sleep(1200)
  return browser.eval(`(() => {
    const dlg = document.querySelector('[data-e2e="im-dialog"]')
    if (!dlg) return true
    let n = dlg
    for (let i = 0; i < 8 && n; i++) {
      if (getComputedStyle(n).display === 'none') return true
      n = n.parentElement
    }
    return false
  })()`).catch(() => false)
}

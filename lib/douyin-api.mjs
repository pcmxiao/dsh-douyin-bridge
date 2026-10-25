/**
 * lib/douyin-api.mjs —— 走抖音自己的接口读私信（**不碰 DOM**）
 * ============================================================================
 * 为什么要这层：
 *
 * 之前读私信靠解析 DOM（`ConversationItemwrapper` 这类 class）。抖音改版
 * 或者换个窗口尺寸就会崩 —— 实测已经踩过：面板 0×0、输入框跑到视口外、
 * 点错层级导致 toggle 把面板关掉。
 *
 * 这一层改成**读抖音自己的接口**。抓包确认的三层：
 *
 *   · `www.douyin.com/aweme/v1/web/im/*`  HTTP + JSON
 *   · `imapi.douyin.com/v1|v2|v3/*`       HTTP + **protobuf**（会话/消息/发送/已读）
 *   · `wss://frontier-im.douyin.com/ws/v2` WebSocket + protobuf（推送）
 *
 * 🔴 关键设计：**不自己拼请求**。
 *    imapi 的请求要带 `a_bogus` 签名，那是抖音自己的 JS 在页面里算的。
 *    所以我们用 `Page.addScriptToEvaluateOnNewDocument` 在页面里 hook 住
 *    `fetch` / `XMLHttpRequest`，让抖音**自己**去请求，我们把响应截下来解码。
 *
 *    好处：签名、cookie、风控参数全都由浏览器负责，我们只解 protobuf。
 *    代价：得先「触发」一次请求（打开面板 / 切会话），数据才会来。
 *
 * 字段映射（实测 2026-10，`v1/message/get_by_conversation`）：
 *
 *   顶层  #1 status_code  #4 status_msg  #6 数据体
 *   #6.#301.#1[] = 消息列表
 *     每条消息：
 *       #1  会话 id（`0:1:xxx:yyy`）
 *       #2  会话类型
 *       #6  消息类型（7 = 文本，15 = 其他，1 = 系统）
 *       #7  发送者 id
 *       #8  JSON 正文（`{"text":"..."}` 或 `{"tips":"..."}`）
 *       #10 服务端时间（毫秒）
 *       #14 发送者 sec_uid
 *       #17 序号
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { parseTree, getInt, getString, all } from './pb.mjs'

/** 消息类型 */
const KIND_TEXT = 7

/**
 * hook 脚本的源码。
 *
 * 🔴 必须**在页面加载前**注册（`Page.addScriptToEvaluateOnNewDocument`），
 *    否则只能截到「装上之后」的请求。抖音的私信接口只在首次进会话时请求一次，
 *    晚了就抓不到 —— 只能 reload 重来。
 *
 * 所以这段源码是**常量导出**的，给 `browser.addPreloadScript()` 用。
 */
export const HOOK_SOURCE = String.raw`
    (function () {
      // 🔴 版本号。改了 hook 就 +1。
      //
      //    为什么要这个：preload 脚本在 target 上是**累积注册**的，
      //    改完代码重新 attach 时旧版可能还挂着（CDP 没有「列已注册脚本」的接口，
      //    跨进程重启更清不掉）。旧版会先执行并把 window.__dyIM 占住，
      //    新版就变成空转 —— 表现就是「hook 在，但一条都抓不到」。
      //
      //    所以：版本不一致就**顶掉旧的**，重装一遍。
      const VERSION = 3;
      if (window.__dyIM && window.__dyIM.version === VERSION) return;

      const MAX = 40;
      const log = [];
      const push = (o) => { log.push(o); if (log.length > MAX) log.shift(); };

      // 二进制响应转 base64（跨 CDP 传得动）
      const toB64 = (buf) => {
        const bytes = new Uint8Array(buf);
        let bin = '';
        const CH = 0x8000;
        for (let i = 0; i < bytes.length; i += CH) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        }
        return btoa(bin);
      };

      const isIM = (url) => /imapi\.douyin\.com|\/aweme\/v1\/web\/im\//i.test(String(url));

      // ── fetch ──────────────────────────────────────────────
      const of = window.fetch;
      window.fetch = async function (...args) {
        const req = args[0];
        const url = typeof req === 'string' ? req : (req && req.url) || '';
        const res = await of.apply(this, args);
        if (!isIM(url)) return res;
        try {
          const clone = res.clone();
          const ct = clone.headers.get('content-type') || '';
          if (/protobuf|octet-stream/i.test(ct)) {
            const buf = await clone.arrayBuffer();
            push({ url: String(url), kind: 'pb', b64: toB64(buf), at: Date.now() });
          } else {
            const text = await clone.text();
            push({ url: String(url), kind: 'json', text: text.slice(0, 200000), at: Date.now() });
          }
        } catch (e) { /* 读失败就算了，别影响页面 */ }
        return res;
      };

      // ── XHR ────────────────────────────────────────────────
      //
      // 🔴 抖音的 IM 请求**走 XHR，不走 fetch**（实测：fetch 里只有扩展图标和埋点，
      //    imapi.douyin.com 的请求全在 XHR 里）。所以这段才是主力。
      //
      // ⚠️ 两个坑：
      //   ① this.responseType 可能不是 arraybuffer，this.response 就不是
      //      ArrayBuffer —— 原来的 instanceof ArrayBuffer 判断会永远 false，
      //      一条都抓不到。改成按 responseType 分支 + 兜底读 responseText。
      //   ② 不能替抖音改它的 responseType（会破坏它自己的解析），
      //      所以：能拿 ArrayBuffer 就拿，拿不到就按 latin1 把文本转回字节。
      const oOpen = XMLHttpRequest.prototype.open;
      const oSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function (m, u, ...rest) {
        this.__dyUrl = String(u);
        this.__dyIsIM = isIM(u);
        return oOpen.call(this, m, u, ...rest);
      };

      XMLHttpRequest.prototype.send = function (body) {
        if (this.__dyIsIM) {
          this.addEventListener('load', () => {
            try {
              const url = this.__dyUrl;
              const ct = this.getResponseHeader('content-type') || '';
              const rt = this.responseType;

              // ① 二进制（protobuf）
              if (rt === 'arraybuffer' && this.response instanceof ArrayBuffer) {
                push({ url, kind: 'pb', b64: toB64(this.response), at: Date.now() });
                return;
              }
              // ② 二进制 blob
              if (rt === 'blob' && this.response instanceof Blob) {
                this.response.arrayBuffer().then((buf) => {
                  push({ url, kind: 'pb', b64: toB64(buf), at: Date.now() });
                }).catch(() => {});
                return;
              }
              // ③ 文本（JSON）
              if (rt === '' || rt === 'text') {
                const text = this.responseText;
                if (typeof text === 'string' && text.length) {
                  const isPb = /protobuf|octet-stream/i.test(ct) || /^[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 1));
                  if (isPb) {
                    // 文本模式下读到的二进制是 latin1 —— 转回字节
                    const bytes = new Uint8Array(text.length);
                    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
                    push({ url, kind: 'pb', b64: toB64(bytes.buffer), at: Date.now() });
                  } else {
                    push({ url, kind: 'json', text: text.slice(0, 200000), at: Date.now() });
                  }
                }
                return;
              }
              // ④ 其他 responseType：只记 URL，至少能看出它发过
              push({ url, kind: 'meta', rt, ct, at: Date.now() });
            } catch (e) {
              // ⚠️ 不能静默吞：读响应失败时留个记号，否则表现就是「hook 在但 0 条」
              push({ url: this.__dyUrl, kind: 'err', err: String(e && e.message || e), at: Date.now() });
            }
          });

          // 出错也要记一笔
          this.addEventListener('error', () => {
            push({ url: this.__dyUrl, kind: 'neterr', at: Date.now() });
          });
        }
        return oSend.call(this, body);
      };

      window.__dyIM = {
        version: VERSION,
        log,
        drain() { const out = log.slice(); log.length = 0; return out; },
        peek() { return log.slice(); },
      };
    })();
  `

/**
 * 在页面里装 hook（当前页面立即生效）。
 *
 * ⚠️ 这只是「补一次」—— 真正可靠的做法是
 *    `browser.addPreloadScript(HOOK_SOURCE)`，让每次导航都自动注入。
 *    两个都做：preload 管以后，这里管当前这一页。
 */
export async function installHook(browser) {
  try { browser.addPreloadScript(HOOK_SOURCE) } catch { /* 老版本 Browser 没有这方法 */ }
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK_SOURCE }, browser.sessionId)
  await browser.eval(HOOK_SOURCE).catch(() => {})
  return true
}

/** hook 是否在位 */
export async function hookReady(browser) {
  try {
    return await browser.eval(`Boolean(window.__dyIM && window.__dyIM.peek)`).catch(() => false)
  } catch { return false }
}

/** 取走已抓到的响应并清空 */
export async function drain(browser) {
  try {
    return await browser.eval(`(window.__dyIM && window.__dyIM.drain) ? window.__dyIM.drain() : []`)
  } catch { return [] }
}

/** 只看不清空 */
export async function peek(browser) {
  try {
    return await browser.eval(`(window.__dyIM && window.__dyIM.peek) ? window.__dyIM.peek() : []`)
  } catch { return [] }
}

/**
 * 拿到「我自己」的 sec_uid。
 *
 * 从 `localStorage.user_info` 读 —— 抖音登录后会把
 * `{uid:"MS4wLjABAAAA...", nickname:"...", avatarUrl:"..."}` 写在这里。
 * `uid` 字段其实是 **sec_uid**（MS4wLjABAAAA 开头），和消息里的 `#14` 同一种格式。
 *
 * ⚠️ 不要硬编码自己的 id：换号就废了。
 *
 * @returns {Promise<{secUid:string, nickname:string}>}
 */
export async function selfInfo(browser) {
  try {
    const r = await browser.eval(String.raw`(() => {
      try {
        const raw = localStorage.getItem('user_info')
        if (!raw) return null
        const o = JSON.parse(raw)
        return { secUid: String(o.uid || ''), nickname: String(o.nickname || '') }
      } catch (e) { return null }
    })()`)
    if (r && r.secUid) return r
  } catch { /* 落到下面 */ }

  // 兜底：从页面里的头像/昵称区域猜（一般不走到这）
  return { secUid: '', nickname: '' }
}

/**
 * 把 hook 抓到的一条 protobuf 响应解成消息数组。
 *
 * @param {Buffer} raw
 * @param {{ selfSecUid?: string }} opts 用来判断「谁发的」
 * @returns {{ ok:boolean, statusCode:number, statusMsg:string, messages:Array }}
 */
export function parseMessages(raw, opts = {}) {
  let tree
  try { tree = parseTree(raw) } catch (e) {
    return { ok: false, statusCode: -1, statusMsg: `解码失败：${e?.message || e}`, messages: [] }
  }

  // ⚠️ status_code 不能拿来判成败：`get_by_conversation` 成功时返回的是 **301**
  //    （protobuf 里 #1=301、#4="OK"）。真正判据是「有没有解出消息」。
  const statusCode = getInt(tree, 1) ?? -1
  const statusMsg = getString(tree, 4)

  // 数据体在 #6，里面套 #301（字段号会变，所以退一步找「第一个 message 子字段」）
  const body = tree.find((n) => n.field === 6 && n.kind === 'message')
  if (!body) return { ok: false, statusCode, statusMsg, messages: [] }

  // 找装消息列表的那一层：某个 message 字段下有 ≥1 个重复的 #1 message
  const listHolder = body.children.find(
    (n) => n.kind === 'message' && n.children.some((c) => c.field === 1 && c.kind === 'message'),
  )
  const listNode = listHolder || body

  const items = all(listNode.children, 1).filter((n) => n.kind === 'message')

  const selfSecUid = String(opts.selfSecUid || '')

  const messages = []
  for (const it of items) {
    const c = it.children
    const kind = getInt(c, 6) ?? 0
    const senderId = getInt(c, 7) ?? 0
    const timeMs = getInt(c, 10) ?? 0
    const secUid = getString(c, 14)

    // 正文：优先 #8 的 JSON
    let text = ''
    let tips = ''
    let shareAweme = null
    const j = getString(c, 8)
    if (j) {
      try {
        const o = JSON.parse(j)
        text = String(o.text ?? o.content ?? '')
        tips = String(o.tips ?? '')
        if (o.aweme_id || o.awemeId) shareAweme = String(o.aweme_id ?? o.awemeId)
      } catch {
        text = j   // 不是 JSON 就当纯文本
      }
    }
    // 有些消息正文在 #9 的属性里（key 叫 content / text）
    if (!text) {
      for (const a of c.filter((x) => x.field === 9 && x.kind === 'message')) {
        const k = getString(a.children, 1)
        const v = getString(a.children, 2)
        if (v && /^(content|text|s:content|s:text)$/i.test(k)) { text = v; break }
      }
    }

    messages.push({
      /** 抖音自己的消息序号（越大越新） */
      seq: getInt(c, 17) ?? 0,
      kind,
      senderId,
      secUid,
      time: timeMs,
      text,
      tips,
      shareAweme,
      /** 是不是文本消息（能直接回） */
      isText: kind === KIND_TEXT,
      /** 系统提示（互相关注、可以开始聊天等） */
      isSystem: Boolean(tips) || kind === 1,
      /** 是不是我自己发的（靠 sec_uid 比对，拿不到就当未知） */
      fromMe: selfSecUid ? secUid === selfSecUid : null,
      convId: getString(c, 1),
    })
  }

  // 按 seq 排序（接口返回的顺序不保证）
  messages.sort((a, b) => a.seq - b.seq)

  return { ok: messages.length > 0, statusCode, statusMsg, messages }
}

/**
 * 缓存：按会话 id 存最近一次解出来的消息。
 *
 * 🔴 为什么必须有这层：
 *    抖音只在「第一次进某个会话」时请求 `get_by_conversation`，
 *    之后全走内存缓存。桥接每 20 秒轮询一次，如果每轮都指望抓到新响应，
 *    除了第一轮之外永远抓不到 —— 于是每轮都要 reload（40 秒），不可接受。
 *
 *    所以：抓到就存下来；抓不到就用上次的缓存。
 *
 * ⚠️ 缓存**要落盘**：插件热重载 / 进程重启后内存缓存就没了，
 *    而抖音那边也不会再发请求 —— 不落盘的话每次重启都要重新 reload 一次。
 *
 * key = 会话 id（`0:1:xxx:yyy`），拿不到就用好友名。
 */
const messageCache = new Map()
let cacheFile = ''
let cacheLoaded = false

/** 设置缓存文件路径（bridge 启动时调一次） */
export function setCacheFile(file) {
  cacheFile = String(file || '')
  if (cacheFile && !cacheLoaded) loadCacheFromDisk()
}

function loadCacheFromDisk() {
  cacheLoaded = true
  if (!cacheFile) return
  try {
    const raw = readFileSync(cacheFile, 'utf8')
    const obj = JSON.parse(raw)
    for (const [k, v] of Object.entries(obj || {})) {
      if (v && Array.isArray(v.messages) && v.messages.length) messageCache.set(k, v)
    }
  } catch { /* 没有或坏了都当空缓存 */ }
}

function saveCacheToDisk() {
  if (!cacheFile) return
  try {
    const obj = {}
    for (const [k, v] of messageCache) obj[k] = v
    writeFileSync(cacheFile, JSON.stringify(obj), 'utf8')
  } catch { /* 写不进去不影响主流程 */ }
}

/** 存一份缓存 */
export function cacheMessages(key, messages, meta = {}) {
  // ⚠️ 空数组不写缓存 —— 否则「这一轮没抓到」会被当成「这个会话没消息」，
  //    后面每次都直接返回空，永远不再尝试。
  if (!key || !Array.isArray(messages) || messages.length === 0) return
  messageCache.set(key, { messages, at: Date.now(), ...meta })
  saveCacheToDisk()
}

/** 取缓存（没有就 null） */
export function cachedMessages(key) {
  return messageCache.get(key) || null
}

/** 清缓存（reload 后调用，因为 seq 可能整体变） */
export function clearCache() {
  messageCache.clear()
  saveCacheToDisk()
}

/** 缓存统计（排障用） */
export function cacheStats() {
  return [...messageCache].map(([k, v]) => ({ key: k, n: v.messages.length, at: v.at }))
}

/**
 * 后台累积器：定期把 hook 里的新响应解出来存进缓存。
 *
 * 🔴 这是让「接口路径」真正可用的关键。
 *
 *    抖音只在**首次进某个会话**时请求 `get_by_conversation`，之后走内存缓存。
 *    所以「按需读」一定会卡在「这一轮没数据」上，然后被迫 reload（30~40 秒）。
 *
 *    但如果**一直挂着 hook**，抖音自己刷新（轮询推送、切会话、刷新页面）
 *    产生的响应都会被截下来。累积器每 2 秒扫一次 hook，解出消息就进缓存。
 *    之后 `readDM` 直接命中缓存 —— 3ms。
 *
 * @returns {() => void} 停止函数
 */
export function startCollector(browser, opts = {}) {
  const every = Math.max(1000, Number(opts.intervalMs) || 2000)
  let stopped = false
  let timer = null

  const tick = async () => {
    if (stopped) return
    try {
      const captured = await drain(browser)
      const pb = (captured || []).filter((c) => c.kind === 'pb' && /get_by_conversation|get_user_message|message\/list/i.test(String(c.url)))
      if (pb.length) {
        const me = await selfInfo(browser).catch(() => ({ secUid: '' }))
        const parsed = pickMessages(captured, { selfSecUid: me.secUid })
        if (parsed.messages?.length) {
          // 按会话 id 分组缓存
          const byConv = new Map()
          for (const m of parsed.messages) {
            const k = m.convId || '*'
            if (!byConv.has(k)) byConv.set(k, [])
            byConv.get(k).push(m)
          }
          for (const [k, list] of byConv) cacheMessages(k, list, { source: parsed.source })
          // 也存一份到 '*'（不分会话的兜底）
          cacheMessages('*', parsed.messages, { source: parsed.source })
          if (typeof opts.onMessages === 'function') {
            try { opts.onMessages(parsed.messages) } catch { /* 上层出错不影响收集 */ }
          }
        }
      }
    } catch { /* 这一轮失败无所谓，下一轮再来 */ }

    if (!stopped) timer = setTimeout(tick, every)
  }

  void tick()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}

/**
 * 强制触发一次「拉消息」请求。
 *
 * 🔴 问题：会话已经打开过时，抖音**不会重新请求** —— 数据在内存缓存里。
 *    表现：hook 装好了、会话也进了，`drain()` 却是空的。
 *
 * 试过但**不通**的路（记下来，免得再走一遍）：
 *
 *   · 在页面里直接 `fetch('imapi.douyin.com/v1/message/get_by_conversation')`
 *     → 请求体不是纯 protobuf，而是「base64 外壳 + 内层 protobuf」的自定义帧
 *       （hex 开头 `434b3043` 就是 ASCII `CK0CEJZO` 的 base64）。
 *       空 body 或乱拼 body 都换不回数据。
 *
 *   · 只靠 UI 切换会话
 *     → 切回来时抖音仍走内存缓存，不发请求。
 *
 * 现在用的：**reload 一次**（清内存缓存），再重新开面板进会话。
 * 慢（约 10 秒），但确定有效，而且只在「hook 里没数据」时才走。
 *
 * @returns {Promise<{ok:boolean, via:string}>}
 */
export async function triggerFetch(browser) {
  // reload 到首页 —— 这一步会清掉抖音的 IM 内存缓存
  await browser.goto('https://www.douyin.com/jingxuan', { settleMs: 8000 })
  return { ok: true, via: 'reload' }
}

/**
 * 从 hook 抓到的响应里，挑出「消息历史」那条并解析。
 *
 * @param {Array} captured drain() 的结果
 * @param {{ selfSecUid?: string }} opts
 * @returns {{ ok:boolean, messages:Array, source?:string, error?:string }}
 */
export function pickMessages(captured, opts = {}) {
  const hits = (captured || []).filter(
    (x) => x.kind === 'pb' && /get_by_conversation|get_user_message|message\/list/i.test(String(x.url)),
  )
  if (!hits.length) return { ok: false, messages: [], error: '没抓到消息接口的响应' }

  // 🔴 按**解出来的消息条数**挑，不按响应大小。
  //    响应大小会骗人：`mark_read`、`get_info_list` 这些也可能很大，
  //    但里面一条消息都没有。以前按 b64 长度排序，就会选中这些空壳，
  //    表现为「抓到了响应、解出 0 条」。
  let best = null
  for (const h of hits) {
    try {
      const raw = Buffer.from(h.b64, 'base64')
      const parsed = parseMessages(raw, opts)
      const useful = parsed.messages.filter((m) => m.text || m.tips || m.shareAweme)
      if (!best || useful.length > best.useful) {
        best = { parsed, useful: useful.length, url: h.url, bytes: raw.length }
      }
    } catch { /* 这条解不开就跳过 */ }
  }

  if (!best) return { ok: false, messages: [], error: '抓到的响应都解不开' }
  return { ...best.parsed, source: best.url, bytes: best.bytes }
}

/**
 * src/browser.mjs —— 零依赖的 CDP 浏览器控制
 * ============================================================================
 * 为什么不用 Playwright / Puppeteer：
 *   · 它们要下载 ~150MB 的 Chromium（用户机器上通常已经有 Edge/Chrome）
 *   · 装包时间长、体积大
 *   · 而我们只需要 CDP 的 5 个能力：导航 / 执行 JS / 截图 / 读 cookie / 抓网络
 *
 * Node 22+ 自带 WebSocket 和 fetch，所以这一整套**零依赖**。
 *
 * 🔴 踩过的坑（全部有代价，别删注释）：
 *   1. **不要加 `--disable-blink-features=AutomationControlled`**
 *      Edge 155 会报"不受支持"，而且导致 `Page.navigate` **静默失效**
 *      （窗口开着但停在 about:blank，看起来像"浏览器坏了"）
 *   2. **不要覆盖 User-Agent** —— 抖音会比对 UA 与真实指纹，
 *      改了反而暴露（实测首页正文从 2070 字掉到 977 字）
 *   3. **不要注入 navigator 补丁** —— 补丁本身就是特征
 *   4. **窗口停到屏幕外 = occluded = 停止绘制** —— feed 永远不 hydrate
 *      ⇒ 要加 --disable-backgrounding-occluded-windows 三件套
 *   5. **导航后必须验证 location.href** —— Page.navigate 可能静默失败
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const LAUNCH_FLAGS = [
  // ⚠️ 不要加 --disable-blink-features=AutomationControlled（见文件头注释）
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1400,1000',
]

const BROWSER_CANDIDATES = {
  win32: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge'],
}

/** 找系统里能用的浏览器 */
export function findBrowser(explicit = '') {
  if (explicit && existsSync(explicit)) return explicit
  for (const p of BROWSER_CANDIDATES[process.platform] || []) {
    if (existsSync(p)) return p
  }
  for (const n of ['msedge', 'chrome', 'google-chrome', 'chromium']) {
    const dirs = String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')
    for (const d of dirs) {
      for (const ext of process.platform === 'win32' ? ['.exe'] : ['']) {
        const f = join(d, n + ext)
        if (existsSync(f)) return f
      }
    }
  }
  return ''
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 一个受控浏览器实例。
 */
export class Browser {
  constructor({ exe, userDataDir, port = 47880, log = () => {} }) {
    this.exe = exe
    this.userDataDir = userDataDir
    this.port = port
    this.log = log
    this.proc = null
    this.ws = null
    this.sessionId = null
    this.targetId = null
    this.nextId = 0
    this.pending = new Map()
    this.events = []
    this.ready = false
    this.attached = false   // true = 连上已有实例，不是自己 spawn 的
    /**
     * 每次导航前都要跑的脚本（`Page.addScriptToEvaluateOnNewDocument`）。
     *
     * 用 `addPreloadScript(src)` 追加。必须在 attach 之前加进去，
     * 这样页面一加载就会先执行 —— 用来装 IM hook 这类「必须在请求前就位」的东西。
     */
    this.preloadScripts = []
  }

  /** 追加一段「每次导航都先跑」的脚本（attach 时统一注册） */
  addPreloadScript(source) {
    if (typeof source === 'string' && source && !this.preloadScripts.includes(source)) {
      this.preloadScripts.push(source)
    }
    return this
  }

  get base() { return `http://127.0.0.1:${this.port}` }

  async launch() {
    if (this.ready) return
    if (!this.exe) {
      throw new Error(
        '找不到 Edge / Chrome。\n'
        + '  装一个，或者用 --browser <路径> 指定。',
      )
    }
    mkdirSync(this.userDataDir, { recursive: true })

    this.proc = spawn(this.exe, [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.userDataDir}`,
      ...LAUNCH_FLAGS,
      'about:blank',
    ], { stdio: 'ignore', windowsHide: false })

    this.proc.on('exit', (code) => {
      this.log(`浏览器退出（code=${code}）`)
      this.ready = false
      this.proc = null
    })

    // 等 CDP 端口起来
    let ver = null
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(`${this.base}/json/version`)
        if (r.ok) { ver = await r.json(); break }
      } catch { /* 还没起来 */ }
      await sleep(250)
    }
    if (!ver) throw new Error(`浏览器起来了但 CDP 端口 ${this.port} 没响应（端口被占用？）`)
    this.log(`浏览器就绪：${ver.Browser}`)

    await this.#attach(ver.webSocketDebuggerUrl)
  }

  /** 连接一个已经在跑的浏览器（不新开窗口） */
  async connect() {
    let ver = null
    try {
      const r = await fetch(`${this.base}/json/version`)
      if (r.ok) ver = await r.json()
    } catch { return false }
    if (!ver) return false

    try {
      await this.#attach(ver.webSocketDebuggerUrl)
      this.attached = true
      return true
    } catch {
      return false
    }
  }

  async #attach(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('连 CDP WebSocket 超时')), 15000)
      this.ws.onopen = () => { clearTimeout(t); res() }
      this.ws.onerror = () => { clearTimeout(t); rej(new Error('CDP WebSocket 出错')) }
    })
    this.ws.onmessage = (ev) => this.handleMessage(ev)

    // 复用已有 tab（连上来的情况），或者新建一个
    const { targetInfos } = await this.send('Target.getTargets')
    const page = targetInfos.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
    let targetId = page?.targetId
    if (!targetId) {
      const r = await this.send('Target.createTarget', { url: 'about:blank' })
      targetId = r.targetId
    }

    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true })
    this.targetId = targetId
    this.sessionId = sessionId

    await this.send('Page.enable', {}, sessionId)
    await this.send('Runtime.enable', {}, sessionId)
    await this.send('Network.enable', { maxPostDataSize: 65536 }, sessionId)

    // 🔴 在**页面加载前**就注册的脚本（`addScriptToEvaluateOnNewDocument`）。
    //
    //    为什么必须在 attach 阶段做：
    //      hook 只能截获「装上之后」发生的请求。抖音的私信接口只在
    //      首次进会话 / 页面加载时请求一次，如果等插件「要读私信」时才装 hook，
    //      那一次请求早就过去了 —— 只能靠 reload 重来（30~40 秒）。
    //      在这里注册后，**任何**页面导航（包括用户手动刷新）都会先跑这段脚本，
    //      请求自然就落进 hook 里了。
    //
    // ⚠️ 同一个 target 上重复注册会**累积**（旧脚本还在，新的也跑），
    //    改代码后旧版 hook 会一直挡在前面。所以先清掉这一轮之前注册的。
    try {
      await this.send('Page.enable', {}, sessionId)
      // CDP 没有「列出已注册脚本」的接口，只能在本次会话里记 identifier 然后删。
      // 跨进程重启时清不掉，那就靠 hook 内部的 `if (window.__dyIM) return`
      // 保证只有第一个生效 —— 但第一个可能是旧的。
      // ⇒ 解决办法：hook 里加版本号，版本不对就**重装**（覆盖 window.__dyIM）。
      if (Array.isArray(this._scriptIds)) {
        for (const id of this._scriptIds) {
          await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id }, sessionId).catch(() => {})
        }
      }
      this._scriptIds = []
      for (const source of this.preloadScripts) {
        try {
          const r = await this.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId)
          if (r?.identifier) this._scriptIds.push(r.identifier)
        } catch { /* 单个脚本失败不影响连接 */ }
      }
    } catch { /* Page 域不可用就跳过 preload */ }

    this.ready = true
  }

  handleMessage(ev) {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      else p.resolve(msg.result)
    } else if (msg.method) {
      this.events.push(msg)
      if (this.events.length > 800) this.events.splice(0, 400)
    }
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('CDP 连接已断'))
      const id = ++this.nextId
      const t = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} 超时`))
      }, 60000)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v) },
        reject: (e) => { clearTimeout(t); reject(e) },
      })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  /** 在页面里执行 JS，返回结果 */
  async eval(expression, opts = {}) {
    if (!this.ready) await this.launch()
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: opts.awaitPromise !== false,
      userGesture: true,
    }, this.sessionId)
    if (r.exceptionDetails) {
      throw new Error(`页面 JS 报错：${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`)
    }
    return r.result?.value
  }

  /**
   * 导航 + 验证。
   *
   * 🔴 Page.navigate 会**静默失败**（不报错，但页面停在 about:blank）。
   *    ⇒ 必须验证 location.href，不对就重试。
   */
  async goto(url, { settleMs = 9000, retries = 2 } = {}) {
    if (!this.ready) await this.launch()
    this.events = []

    let lastHref = ''
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.send('Page.navigate', { url }, this.sessionId)
      } catch (e) {
        if (attempt >= retries) throw new Error(`导航请求失败：${e.message}`)
        await sleep(800)
        continue
      }

      await sleep(Math.min(2500, Math.max(800, settleMs / 3)))
      lastHref = await this.eval('location.href').catch(() => '')

      const ok = lastHref
        && lastHref !== 'about:blank'
        && !lastHref.startsWith('chrome-error://')
        && lastHref !== 'chrome://newtab/'

      if (ok) {
        await sleep(Math.max(0, settleMs - 2500))
        return { url: lastHref, attempt }
      }
      if (attempt < retries) {
        this.log(`导航没生效（还在 ${lastHref || 'about:blank'}），重试…`)
        await sleep(1000)
      }
    }

    throw new Error(
      `导航失败：期望 ${new URL(url).host}，实际停在 ${lastHref || '(空)'}。\n`
      + '  可能：浏览器启动参数不兼容 / 页面被拦 / CDP 会话失效',
    )
  }

  async screenshot() {
    const r = await this.send('Page.captureScreenshot', { format: 'png' }, this.sessionId)
    return Buffer.from(r.data, 'base64')
  }

  /** 抓页面自己发的 XHR（URL 列表） */
  apiUrls(pattern) {
    const re = pattern || /aweme\/v[12]\/web/
    return [...new Set(
      this.events
        .filter((e) => e.method === 'Network.responseReceived')
        .map((e) => e.params.response.url)
        .filter((u) => re.test(u)),
    )]
  }

  /** 读某个响应的 body */
  async responseBody(requestId) {
    const r = await this.send('Network.getResponseBody', { requestId }, this.sessionId)
    return r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body
  }

  /** 读 cookie（含 HttpOnly） */
  async cookies(urls) {
    const r = await this.send('Network.getCookies', { urls }, this.sessionId)
    return r?.cookies || []
  }

  async close() {
    try { this.ws?.close() } catch { /* 忽略 */ }
    if (!this.attached) {
      try { this.proc?.kill() } catch { /* 忽略 */ }
    }
    this.ready = false
    this.ws = null
    this.proc = null
  }

  /**
   * 只断 CDP 连接，**不关浏览器进程**。
   *
   * 插件热重载时用这个：宿主先卸旧实例再装新实例，旧实例要是把浏览器关了，
   * 新实例刚连上的页面就没了（表现为「面板没打开 / 进不去会话」）。
   */
  detach() {
    try { this.ws?.close() } catch { /* 忽略 */ }
    this.ready = false
    this.ws = null
    // 故意不清 this.proc：那个进程还在跑，下次 getBrowser 会 connect() 复用它
  }
}

/**
 * 拿一个浏览器：优先连已运行的，连不上再开新的。
 * 这样登录态能复用，窗口也不会重复开。
 */
export async function getBrowser({ exe, userDataDir, port, log, reuse = true, preloadScripts = [] } = {}) {
  const b = new Browser({ exe: exe || findBrowser(), userDataDir, port, log })
  // 🔴 preload 必须在 connect/launch **之前**塞进去，
  //    否则 attach 时注册的就是空列表（见 #attach 里的说明）。
  for (const src of preloadScripts) b.addPreloadScript(src)
  if (reuse && await b.connect()) {
    log('已连接运行中的浏览器')
    return b
  }
  await b.launch()
  return b
}

/** 清理残留的 profile 锁（浏览器被杀后 Chromium 会留 SingletonLock） */
export function cleanLocks(dir) {
  try {
    for (const f of readdirSync(dir)) {
      if (/^Singleton(Lock|Socket|Cookie)$/.test(f)) {
        try { rmSync(join(dir, f), { force: true }) } catch { /* 忽略 */ }
      }
    }
  } catch { /* 目录不存在 */ }
}

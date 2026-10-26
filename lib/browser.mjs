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
import { spawn, execFile } from 'node:child_process'
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
 * 端口 → Browser 实例（**一个端口只允许一个实例**）。
 *
 * 🔴 为什么必须有这张表（2026-10-26 修，用户报「反复重启浏览器」）：
 *    以前 `getBrowser()` 每次都 `new Browser()`。于是：
 *      · 插件热重载 → 新实例 → 老实例的 CDP 连接还挂着 → 两个 WebSocket
 *      · 老实例 `ready=false` → 又去 spawn 一个新浏览器 ⇒ 窗口反复弹
 *    一个端口一个对象 ⇒ 物理上杜绝「同时开两个窗口」。
 */
const REGISTRY = new Map()

/**
 * 端口 → 正在进行的启动流程。
 *
 * 🔴 没有这个锁的时候：轮询 + 工具调用同时进来，
 *    两个 `launch()` 并行 ⇒ **两个 Edge 窗口**。
 *    现在同一个端口的并发调用共享同一个 Promise。
 */
const LAUNCHING = new Map()

/** PowerShell 单引号转义 */
const psQuote = (s) => String(s).replace(/'/g, "''")

/** 跑一条 PowerShell，拿到 stdout（失败返回空串） */
function psExec(script, timeout = 20000) {
  return new Promise((resolve) => {
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        timeout,
        windowsHide: true,
      }, (err, stdout) => resolve(err ? '' : String(stdout || '')))
    } catch { resolve('') }
  })
}

/**
 * 找出「用同一个 profile 或同一个调试端口」的浏览器进程 pid。
 *
 * 🔴 为什么需要：浏览器进程还活着、但 CDP 端口没了的时候，
 *    再 spawn 一个会被老实例「转交」掉（我们的新进程立刻 code=0 退出），
 *    端口于是永远起不来 ⇒ **无限重启浏览器**。
 *    必须先把老进程清掉再开新的。
 *
 * 查不到就返回空数组 —— 宁可不清，也不能误杀用户自己开的浏览器。
 *
 * @returns {Promise<number[]>}
 */
export async function browserProcesses(userDataDir = '', port = 0) {
  if (process.platform !== 'win32') return []
  const dir = psQuote(userDataDir)
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$all = Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\"",
    "$hit = $all | Where-Object { $_.CommandLine -and $_.CommandLine -notlike '*--type=*' -and (",
    `  (${dir ? "($_.CommandLine -like ('*' + '" + dir + "' + '*'))" : '$false'}) -or`,
    `  (${port ? `($_.CommandLine -like ('*remote-debugging-port=${port}*'))` : '$false'})`,
    ') }',
    "Write-Output (($hit | ForEach-Object { $_.ProcessId }) -join ',')",
  ].join('\n')
  const out = await psExec(script)
  return out.trim().split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
}

/** 连根杀一个进程树（Windows） */
export async function killTree(pid) {
  if (!pid || process.platform !== 'win32') return false
  const out = await psExec(`taskkill /PID ${Number(pid)} /T /F 2>&1 | Out-String`, 15000)
  return !/没有找到进程|not found/i.test(out)
}

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
    /** 浏览器没了的时候回调（参数：进程退出码；0 = 用户把窗口关了） */
    this.onDead = null
    /** 插件卸载时会置位 —— 这时不该再触发 onDead（不是浏览器的问题） */
    this.disposed = false
    /** 成功连上过（用来判断「浏览器真的死了」而不是「还没启动」） */
    this.everAttached = false
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
    if (typeof source !== 'string' || !source) return this
    if (!this.preloadScripts.includes(source)) {
      this.preloadScripts.push(source)
      // 🔴 已经连上了才补的脚本 ⇒ 立刻注册。
      //    不然它会一直等到「下一次导航」才生效（浏览器不导航就永远不生效）。
      if (this.ready && this.sessionId) {
        void (async () => {
          try {
            const r = await this.send('Page.addScriptToEvaluateOnNewDocument', { source }, this.sessionId)
            if (r?.identifier) this._scriptIds.push(r.identifier)
          } catch { /* 单个脚本失败不影响连接 */ }
        })()
      }
    }
    return this
  }

  /** 连接还在、ready 也没被清 ⇒ 这浏览器还能用 */
  isAlive() {
    return Boolean(this.ready && this.ws && this.ws.readyState === 1 && !this.disposed)
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

    // 🔴 ① 端口上已经有浏览器了 —— **绝不能再开一个**。
    //
    //    两个浏览器共用同一个 --user-data-dir 会互相踩：
    //    profile 锁、LevelDB、调试端口全在打架，
    //    表现就是「CDP 连接已断」「页面永远停在 about:blank」。
    const existing = await this.probePort()
    if (existing) {
      this.log(`CDP 端口 ${this.port} 上已经有浏览器（${existing.Browser}），直接复用`)
      const ok = await this.connect()
      if (ok) return
      throw new Error(
        `CDP 端口 ${this.port} 上已经有浏览器，但连不上。\n`
        + '  多半是别的程序占了这个端口 —— 换个 browserPort 再试。',
      )
    }

    // 🔴 ② 端口没人，但可能还有**用同一个 profile 的僵尸浏览器**。
    //    它还在 ⇒ 我们 spawn 的那个会被它「转交」掉（我们的进程立刻 code=0 退出），
    //    端口于是永远起不来 ⇒ 无限重启浏览器。
    const zombies = await browserProcesses(this.userDataDir, this.port)
    if (zombies.length) {
      this.log(`发现 ${zombies.length} 个用同一 profile / 端口的残留浏览器进程，先清掉`)
      for (const pid of zombies) await killTree(pid)
      await sleep(800)
    }
    // 只有确认没有浏览器占着这个 profile，才敢删锁文件
    // （删早了 ⇒ 新开的浏览器不再认得老实例 ⇒ 两个浏览器抢同一个 profile）
    cleanLocks(this.userDataDir)

    mkdirSync(this.userDataDir, { recursive: true })

    this.proc = spawn(this.exe, [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.userDataDir}`,
      ...LAUNCH_FLAGS,
      'about:blank',
    ], { stdio: 'ignore', windowsHide: false })

    let exited = false
    this.proc.on('exit', (code) => {
      exited = true
      this.log(`浏览器退出（code=${code}）`)
      this.proc = null
      const wasReady = this.ready
      this.ready = false
      // 🔴 **进程退出 ≠ 浏览器没了**。
      //
      //    Edge 的启动进程经常「拉起真正的浏览器进程然后自己退出」（code=0），
      //    这时 CDP 端口还好好的 —— 早先这里一律 ready=false，
      //    下一轮轮询就又去开一个新浏览器 ⇒ 窗口每隔 20 秒自己弹一次。
      //    判据只有一个：**CDP 端口还在不在**。
      void (async () => {
        const alive = await this.probePort()
        if (alive) {
          this.ready = wasReady
          this.log('（CDP 端口仍可用，浏览器由已有实例接管，继续用）')
          return
        }
        if (this.everAttached && !this.disposed) this.onDead?.(code)
      })()
    })

    // 等 CDP 端口起来
    let ver = null
    for (let i = 0; i < 80; i++) {
      if (exited) {
        // 我们的进程退了，但端口可能被别人占着（老实例还活着）⇒ 接管它
        ver = await this.probePort()
        if (ver) {
          this.log('启动进程已退出，但 CDP 端口可用 —— 接管已有实例')
          this.attached = true
          break
        }
        throw new Error(
          '浏览器进程启动后立刻退出。\n'
          + '  多半是同一个 profile 已经被另一个浏览器占着。\n'
          + '  关掉那个窗口再试，或者换一个 userDataDir。',
        )
      }
      try {
        const r = await fetch(`${this.base}/json/version`, { signal: AbortSignal.timeout(2000) })
        if (r.ok) { ver = await r.json(); break }
      } catch { /* 还没起来 */ }
      await sleep(250)
    }
    if (!ver) throw new Error(`浏览器起来了但 CDP 端口 ${this.port} 没响应（端口被占用？）`)
    this.log(`浏览器就绪：${ver.Browser}`)

    await this.#attach(ver.webSocketDebuggerUrl)
  }

  /** 探一下 CDP 端口有没有浏览器在应答 */
  async probePort() {
    try {
      const r = await fetch(`${this.base}/json/version`, { signal: AbortSignal.timeout(2000) })
      if (!r.ok) return null
      return await r.json()
    } catch { return null }
  }

  /** 连接一个已经在跑的浏览器（不新开窗口） */
  async connect() {
    const ver = await this.probePort()
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
    const ws = new WebSocket(wsUrl)
    this.ws = ws
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('连 CDP WebSocket 超时')), 15000)
      ws.onopen = () => { clearTimeout(t); res() }
      ws.onerror = () => { clearTimeout(t); rej(new Error('CDP WebSocket 出错')) }
    })
    ws.onmessage = (ev) => this.handleMessage(ev)
    // 🔴 连接断了必须把 ready 清掉。
    //    以前不清 ⇒ 后面每一轮都拿着一个死连接去发命令，
    //    表现就是「轮询出错：导航请求失败：CDP 连接已断」连着刷 401 次，
    //    而且**永远不会自愈**（因为 ready 一直是 true，没人去重连）。
    ws.onclose = () => {
      if (this.ws !== ws) return
      const wasReady = this.ready
      this.ready = false
      this.ws = null
      if (!wasReady || this.disposed || !this.everAttached) return
      // 🔴 连接断了 ⇒ 浏览器正在关 / 崩了。
      //    一定要通知桥：**别在这个瞬间又去开一个新浏览器**
      //    （浏览器关闭是有过程的，这期间端口已经没了但进程还在 ——
      //      以前就是在这个缝隙里又弹了一个窗口出来）。
      this.onDead?.(-1)
    }

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
    this.everAttached = true
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
      // 🔴 有等待者时立刻通知（`Page.fileChooserOpened` 这类一次性事件必须这样接，
      //    靠轮询 events 数组会漏 —— 事件在两次轮询之间就来了又走了）
      if (this._waiters && this._waiters.length) {
        for (const w of this._waiters.slice()) {
          if (!w.method || w.method === msg.method) {
            if (!w.predicate || w.predicate(msg)) {
              this._waiters.splice(this._waiters.indexOf(w), 1)
              clearTimeout(w.timer)
              w.resolve(msg)
            }
          }
        }
      }
    }
  }

  /**
   * 等一个 CDP 事件。
   *
   * @param {string} method       事件名，如 `Page.fileChooserOpened`
   * @param {object} opts
   * @param {number} opts.timeoutMs
   * @param {Function} opts.predicate 对事件对象做判断
   * @returns {Promise<object>} 事件对象
   */
  waitForEvent(method, { timeoutMs = 10000, predicate = null } = {}) {
    return new Promise((resolve, reject) => {
      if (!this._waiters) this._waiters = []
      const w = { method, predicate, resolve, reject }
      w.timer = setTimeout(() => {
        const i = this._waiters.indexOf(w)
        if (i >= 0) this._waiters.splice(i, 1)
        reject(new Error(`等 CDP 事件 ${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this._waiters.push(w)
    })
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
    // 🔴 **绝不在这里启动浏览器**。
    //    以前是 `if (!this.ready) await this.launch()` —— 而后台累积器每 2 秒
    //    调一次 eval。于是：浏览器一死 → 2 秒后累积器把它又拉起来 ⇒
    //    **窗口每隔 2 秒自己弹一次**。
    //    要不要开浏览器只有一个地方能决定：桥的 ensureBrowser()。
    if (!this.ready) throw new Error('浏览器没连上（连接已断），需要重新获取浏览器')
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
    // 🔴 同 eval()：不在这里启动浏览器（见上面的说明）
    if (!this.ready) throw new Error('浏览器没连上（连接已断），需要重新获取浏览器')
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

  /**
   * 读某个响应的 body。
   *
   * 🔴 **必须返回 Buffer，不能转成字符串**（2026-10 踩过）：
   *    CDP 对二进制响应会返回 `base64Encoded: true`。之前这里
   *    `Buffer.from(r.body, 'base64').toString('utf8')` —— UTF-8 解码会把
   *    非法字节变成 U+FFFD（`ef bf bd`），protobuf 直接被毁掉，
   *    表现为「解出来只有 5 个字段，值全是乱码」。
   */
  async responseBody(requestId) {
    const r = await this.send('Network.getResponseBody', { requestId }, this.sessionId)
    return r.base64Encoded ? Buffer.from(r.body, 'base64') : Buffer.from(r.body, 'utf8')
  }

  /**
   * 找出「最近某个时刻之后」的、URL 命中 pattern 的响应事件。
   *
   * 用 CDP 的 Network 域抓抖音自己的接口响应 —— 比在页面里 hook XHR 稳得多
   * （抖音会在 document-start 之后重新包一层 XHR，我们的 hook 会被顶掉）。
   *
   * @param {RegExp|string} pattern URL 匹配
   * @param {number} since 只看这个序号之后的事件（`this.events.length` 的快照）
   * @returns {Array<{requestId:string, url:string, status:number, mime:string}>}
   */
  imResponses(pattern, since = 0) {
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern)
    const out = []
    for (const e of this.events.slice(since)) {
      if (e.method !== 'Network.responseReceived') continue
      const url = String(e.params?.response?.url || '')
      if (!re.test(url)) continue
      out.push({
        requestId: e.params.requestId,
        url,
        status: e.params.response?.status ?? 0,
        mime: e.params.response?.mimeType || '',
      })
    }
    return out
  }

  /** 读 cookie（含 HttpOnly） */
  async cookies(urls) {
    const r = await this.send('Network.getCookies', { urls }, this.sessionId)
    return r?.cookies || []
  }

  async close() {
    this.disposed = true
    try { this.ws?.close() } catch { /* 忽略 */ }
    if (!this.attached) {
      try { this.proc?.kill() } catch { /* 忽略 */ }
    }
    this.ready = false
    this.ws = null
    this.proc = null
    REGISTRY.delete(String(this.port))
  }

  /**
   * 只断 CDP 连接，**不关浏览器进程**。
   *
   * 插件热重载时用这个：宿主先卸旧实例再装新实例，旧实例要是把浏览器关了，
   * 新实例刚连上的页面就没了（表现为「面板没打开 / 进不去会话」）。
   */
  detach() {
    this.disposed = true
    try { this.ws?.close() } catch { /* 忽略 */ }
    this.ready = false
    this.ws = null
    REGISTRY.delete(String(this.port))
    // 故意不清 this.proc：那个进程还在跑，下次 getBrowser 会 connect() 复用它
  }
}

/**
 * 拿一个浏览器：优先连已运行的，连不上再开新的。
 * 这样登录态能复用，窗口也不会重复开。
 *
 * 🔴 **一个端口只允许一个 Browser 对象**（2026-10-26 修）：
 *    以前每次都 new 一个 ⇒ 插件热重载后老连接还挂着、新实例又 spawn 一个浏览器，
 *    用户看到的就是「浏览器每隔 20 秒自己弹一次」。
 *
 * 🔴 **同一个端口的并发调用共享一次启动**：
 *    没有这把锁，轮询和工具调用同时进来 ⇒ 两个 launch() ⇒ 两个窗口。
 */
export async function getBrowser({ exe, userDataDir, port, log, reuse = true, preloadScripts = [], onDead = null } = {}) {
  const key = String(port || 47880)

  const cached = REGISTRY.get(key)
  if (cached) {
    for (const src of preloadScripts) cached.addPreloadScript(src)
    if (onDead) cached.onDead = onDead
    if (cached.isAlive()) {
      log('已连接运行中的浏览器')
      return cached
    }
    // 死了（或者被 detach 过）⇒ 丢掉，重新来
    REGISTRY.delete(key)
    try { cached.detach() } catch { /* 忽略 */ }
  }

  if (LAUNCHING.has(key)) return LAUNCHING.get(key)

  const p = (async () => {
    const b = new Browser({ exe: exe || findBrowser(), userDataDir, port, log })
    if (onDead) b.onDead = onDead
    // 🔴 preload 必须在 connect/launch **之前**塞进去，
    //    否则 attach 时注册的就是空列表（见 #attach 里的说明）。
    for (const src of preloadScripts) b.addPreloadScript(src)
    if (reuse && await b.connect()) {
      log('已连接运行中的浏览器')
      REGISTRY.set(key, b)
      return b
    }
    await b.launch()
    REGISTRY.set(key, b)
    return b
  })()

  LAUNCHING.set(key, p)
  try {
    return await p
  } finally {
    if (LAUNCHING.get(key) === p) LAUNCHING.delete(key)
  }
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

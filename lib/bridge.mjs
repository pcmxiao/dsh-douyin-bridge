/**
 * lib/bridge.mjs —— 抖音私信 ⇄ DSH 会话 的桥
 * ============================================================================
 * 这就是「相当于 SnowLuma 的那一层」，只不过桥的是抖音私信而不是 QQ：
 *
 *   抖音私信  ──读──▶  本桥  ──注入──▶  DSH 会话（agent）
 *        ▲                              │
 *        └────────── 发送 ◀── agent 的回复
 *
 * 设计不变量（踩过坑才写下来的）：
 *
 *  1. **会话数据本体在 DSH 里**。这个文件只存两样**索引**：
 *     「聊天对象 ↔ DSH session id」的映射，和「哪些消息已经看过」的去重指纹。
 *     对话内容一律写进 DSH 的 session 日志（`agent/inbox/spliced` + `user/message`），
 *     不在本插件里另存一份。
 *
 *  2. **第一次见到某个好友，只做基线、不注入**。
 *     否则第一次轮询会把对方的历史消息全灌进 DSH 会话。
 *
 *  3. **自己发的消息不回灌**。抖音网页端的「自己发的」= 消息盒里有 `isFromMe`。
 *
 *  4. **系统消息不回灌**。「已互相关注」「暂不支持该消息类型展示」这类不是对话。
 *
 *  5. **回复回流按 session seq 去重**。观察器和轮询两条路都能触发发送，
 *     但同一 seq 只会发一次。
 */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { Browser, getBrowser, findBrowser } from './browser.mjs'
import { dmList, readDM, sendDM, sendImage, sendEmoji, checkLogin, ensurePanel } from './douyin.mjs'
import { dataUrlToBytes } from './media.mjs'
import { HOOK_SOURCE, installHook as apiInstallHook, startCollector as apiStartCollector, setCacheFile as apiSetCacheFile } from './douyin-api.mjs'
import { canary } from './selectors.mjs'
import { readDialog, listBridgeSessions } from './session-history.mjs'
import { loadHostDeps } from './hostdeps.mjs'
import {
  loadConfig, saveConfig, loadSessionMap, saveSessionMap,
  peerSession, setPeerSession, hasSeen, markSeen, fingerprint, appendLog,
} from './state.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 进程级单例锁。
 *
 * 🔴 为什么需要：DSH 热重载时，宿主会先加载新实例再卸旧实例，
 *    中间有一小段时间**两个实例同时活着**。它们各自：
 *      · 跑 `start()` → 日志刷「已启动 / 已停止」
 *      · 跑 `selectorCheck()` → 抢同一个「消息」面板（toggle，一开一关）
 *    结果就是日志里无限刷屏、面板永远打不开。
 *
 *    用一个挂在 globalThis 上的锁，保证「同一时刻只有一个实例在跑轮询/自检」。
 *    放在 globalThis 而不是模块变量：热重载会重新求值模块，模块变量会重置，
 *    globalThis 上的东西不会。
 */
const BRIDGE_LOCK = (globalThis.__douyinBridgeLock ||= {
  owner: 0,        // 当前持有轮询权的实例 id
  seq: 0,          // 实例 id 发号器
  selftest: false, // 是否正在自检
  /** 最近一次 start/stop 的时间戳，用来节流僵尸实例的抖动 */
  lastToggle: 0,
  /** 短时间内允许的启停次数 */
  toggles: 0,
})

/** 从 assistant 消息的 content 块里抽纯文本 */
export function extractText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
}

/** 会话 id 里不能出现的字符（session id 会进文件路径和日志） */
function sanitizeId(s) {
  return String(s || 'peer').replace(/[^0-9A-Za-z_-]/g, '_').slice(0, 32)
}

export class DouyinBridge {
  /**
   * @param {object} p
   * @param {object} p.ctx               DSH 宿主 context
   * @param {(m:string)=>void} p.log
   */
  constructor({ ctx, log = () => {} }) {
    this.ctx = ctx
    this.log = (m) => { log(m); appendLog(m) }
    this.cfg = loadConfig()
    this.map = loadSessionMap()
    this.browser = null
    /**
     * 🔴 浏览器正在启动时的那个 Promise。
     *    轮询和工具调用会同时进来，没有这把锁就是两次 launch ⇒ 两个窗口。
     */
    this._browserPromise = null
    /**
     * 🔴 用户把浏览器窗口关掉了。
     *    置位之后**不再自动拉起**（2026-10-26 修「反复重启浏览器」）。
     *    恢复入口：`douyin_login` 工具 / `POST /dsh-douyin-bridge/start`。
     */
    this.browserClosed = false
    /** 异常退出后的自动重连：次数 + 冷却截止时间 */
    this._relaunchCount = 0
    this._relaunchAt = 0
    this.busy = false
    this.timer = null
    /** 宿主在 setup 回调里挂东西用（值班章程等） */
    this.onSessionSetup = null
    /**
     * 换掉宿主上下文。
     *
     * ⚠️ 插件自己的 ctx 上**读不到** agents / sessions —— DSH 的 cordis 只把
     *    声明过 inject 的服务挂到 ctx 上，直接读会抛
     *    `cannot get property "agents" without inject`。
     *    所以宿主那边 `ctx.inject(['agents','sessions'], (scoped) => …)` 拿到
     *    的 scoped 才带着这两个服务，桥接腿要用它。
     */
    this.setCtx = (ctx) => { this.ctx = ctx }

    /**
     * 附件服务所在的上下文。
     *
     * ⚠️ 单独 inject 是为了不让「没有附件服务」拖垮整个桥接腿
     *    （cordis 的 inject 会等所有依赖到位才跑回调）。
     */
    this.setAttachmentCtx = (ctx) => { this.attCtx = ctx }

    // 接口层的消息缓存落盘 —— 插件热重载 / 进程重启后不用重新 reload 抖音页面
    try {
      apiSetCacheFile(paths.imCache)
    } catch { /* 拿不到路径就算了，退化成纯内存缓存 */ }

    /**
     * 安全读服务。
     *
     * ⚠️ `this.ctx.agents` 在没 inject 声明时会**抛**（cordis 的 Proxy 陷阱），
     *    不是返回 undefined —— `?.` 挡不住，整个插件会直接不激活。
     *    所以一律走 get()：读不到就 undefined。
     */
    this.service = (name) => {
      try { return this.ctx?.get?.(name) } catch { return undefined }
    }
    this.state = {
      lastPollAt: 0,
      lastError: '',
      consecutiveErrors: 0,
      polls: 0,
      injected: 0,
      sent: 0,
      startedAt: Date.now(),
    }
  }

  /**
   * 构造注入用的用户消息。
   *
   * 优先用宿主的 `createUserMessage`（它会冻结消息、盖稳定 id）；
   * 拿不到就用本地等价实现。**只在第一次调用时解析一次**。
   */
  async makeUserMessage(input) {
    if (!this._cUM) {
      try {
        const deps = await loadHostDeps()
        this._cUM = deps.createUserMessage
      } catch {
        this._cUM = (i) => ({ ...structuredClone(i), role: 'user', id: randomUUID() })
      }
    }
    return this._cUM(input)
  }

  /* ── 配置 ──────────────────────────────────────────────────────── */

  reloadConfig() {
    this.cfg = loadConfig()
    return this.cfg
  }

  updateConfig(patch) {
    this.cfg = saveConfig({ ...loadConfig(), ...patch })
    return this.cfg
  }

  /* ── 浏览器 ────────────────────────────────────────────────────── */

  /**
   * 拿一个能用的浏览器。
   *
   * 🔴 **不再无限自动重开浏览器**（2026-10-26 修，用户报「反复重启浏览器」）：
   *
   *    以前：窗口一被关掉 → 进程退出 → `ready=false` → 下一轮轮询又 spawn 一个
   *    ⇒ 浏览器每隔 20 秒自己弹一次，用户关都关不掉。
   *    （日志证据：2026-10-26 15:45–15:51 一连串「浏览器就绪 / 浏览器退出 code=0」）
   *
   *    现在分三种情况：
   *      · **进程干净退出（code=0）** = 用户把窗口关了
   *        ⇒ 标记 browserClosed，**不再自动拉起**，只在日志里说清怎么恢复；
   *      · **异常退出（code≠0 或 CDP 断了）** = 崩了
   *        ⇒ 有限次自动重连（带 30 秒冷却、最多 3 次），免得变成 spawn 循环；
   *      · 显式调用（douyin_login / POST /start）⇒ 无条件重开。
   *
   * @param {object}  o
   * @param {boolean} o.relaunch 强制重开（用户明确要求时用）
   */
  async ensureBrowser({ relaunch = false } = {}) {
    // 串行化：并发调用共享同一次启动
    if (this._browserPromise) return this._browserPromise
    this._browserPromise = (async () => {
      // 已有实例且连接还在 → 直接用
      if (this.browser && this.browser.isAlive()) return this.browser
      // 连接断了 → 丢掉，重新来
      if (this.browser) { this.browser = null }

      if (this.browserClosed && !relaunch) {
        throw new Error(
          '浏览器窗口已经被关掉了，桥接暂停中（不会再自动弹窗口）。\n'
          + '  要恢复：调用 douyin_login 工具，或 POST /dsh-douyin-bridge/start。',
        )
      }
      if (!relaunch && this._relaunchAt && Date.now() < this._relaunchAt) {
        const wait = Math.ceil((this._relaunchAt - Date.now()) / 1000)
        throw new Error(`浏览器刚异常退出，${wait} 秒内不重复拉起（恢复：douyin_login）`)
      }

      // 🔴 关键顺序：**先**把 hook 注册成 preload 脚本，**再**连浏览器。
      //
      //    hook 只能截获「装上之后」的请求。抖音的私信接口只在首次进会话时
      //    请求一次 —— 如果等连上之后再装，那一次请求早就过去了，只能 reload
      //    重来（30~40 秒）。
      //
      //    把源码交给 addPreloadScript，Browser 在 attach 时统一注册到
      //    `Page.addScriptToEvaluateOnNewDocument`，于是**任何**导航
      //    （包括用户手动刷新、插件自己 goto）都会先跑这段 hook。
      const b = await getBrowser({
        exe: this.cfg.browser || findBrowser(),
        userDataDir: this.cfg.userDataDir,
        port: this.cfg.browserPort,
        log: (m) => this.log(`浏览器：${m}`),
        reuse: true,
        preloadScripts: [HOOK_SOURCE],
      })

      // 浏览器没了的时候要通知桥（区分「用户关的」和「崩的」）
      b.onDead = (code) => this.#onBrowserDead(code)

      this.browser = b
      this.browserClosed = false
      this._relaunchCount = 0
      this._relaunchAt = 0

      // 当前这一页可能早就加载完了，preload 不会追溯 —— 补装一次
      if (!this._apiHookInstalled) {
        this._apiHookInstalled = true
        void (async () => {
          try {
            await apiInstallHook(this.browser)
            this.log('IM 接口 hook 已挂上（含 preload）')
            if (this._collector) { try { this._collector() } catch { /* 忽略 */ } }
            this._collector = apiStartCollector(this.browser, {
              intervalMs: 2000,
              onMessages: (msgs) => { this.state.apiMessages = msgs.length },
            })
            this.log('IM 累积器已启动（每 2 秒扫一次）')
          } catch (e) {
            this.log(`IM hook 挂载失败：${e?.message || e}`)
          }
        })()
      }

      return b
    })()

    try {
      return await this._browserPromise
    } finally {
      this._browserPromise = null
    }
  }

  /**
   * 浏览器没了。
   *
   * @param {number} code 进程退出码；0 = 用户关的窗口；-1 = CDP 连接断
   */
  #onBrowserDead(code) {
    const c = Number(code)
    this.state.browserAlive = false
    this.state.lastBrowserExit = { code: c, at: Date.now() }

    if (c === 0) {
      // 干净退出 —— 绝大多数情况是用户把窗口关了
      this.browserClosed = true
      this._relaunchCount = 0
      this._relaunchAt = 0
      this.log('浏览器窗口被关掉了 —— 桥接暂停，不会再自动弹窗口（恢复：douyin_login 或 POST /dsh-douyin-bridge/start）')
      return
    }

    // 连接断了 / 异常退出 —— 先冷却，**别在浏览器关闭的过程中又开一个**
    this._relaunchCount = (this._relaunchCount || 0) + 1
    this._relaunchAt = Date.now() + 30000
    if (this._relaunchCount > 3) {
      this.browserClosed = true
      this.log(`浏览器异常退出 ${this._relaunchCount} 次，不再自动重连（恢复：douyin_login）`)
    } else if (c === -1) {
      this.log(`CDP 连接断了，30 秒内不自动重连（第 ${this._relaunchCount}/3 次）`)
    } else {
      this.log(`浏览器异常退出（code=${c}），30 秒后自动重连（第 ${this._relaunchCount}/3 次）`)
    }
  }

  async loginStatus() {
    const b = await this.ensureBrowser()
    const r = await checkLogin(b)
    return { ...r, browser: this.browser?.exe || '', profile: this.cfg.userDataDir }
  }

  /**
   * 选择器自检（canary）。
   *
   * 抖音改版时某个 class 可能突然不匹配了 —— 以前的表现是「工具返回成功但什么
   * 都没发生」，极难排查。现在主动探一遍关键选择器，把「哪条降级链在生效 /
   * 哪条全挂了」记下来，状态页和日志都能看到。
   *
   * 🔴 三个坑（都踩过）：
   *    ① 自检和轮询**不能同时**动「消息」面板（它是 toggle，一开一关就乱）。
   *    ② 恢复时不能调 `start()` —— 它会先 stop 再排一次自检，形成无限循环。
   *    ③ 热重载会留下**旧实例**，多个实例各自 start/自检，日志刷屏。
   *       用进程级单例锁保证同一时刻只有一个实例在跑。
   *
   * @returns {Promise<{ok:boolean, broken:string[], absent:string[], working:object}>}
   */
  async selectorCheck() {
    // ③ 单例锁：别的实例正在自检就直接返回
    if (BRIDGE_LOCK.selftest) {
      return { ok: true, skipped: '另一个实例正在自检', broken: [], absent: [], working: {} }
    }
    BRIDGE_LOCK.selftest = true

    try {
      const b = await this.ensureBrowser()

      // ① 暂停轮询（记下原来是不是在跑）
      const wasRunning = Boolean(this.timer)
      if (wasRunning) {
        clearInterval(this.timer)
        this.timer = null
      }

      try {
        // 等当前这一轮轮询跑完（busy 会在 finally 里释放）
        for (let i = 0; i < 30 && this.busy; i++) await sleep(1000)

        // 先把面板打开，让要探的元素真的渲染出来
        try {
          const st = await ensurePanel(b)
          if (!st.panelOpen && !st.inChat) {
            this.log(`自检：面板没打开（${st.error || '未知原因'}），结果可能不准`)
          }
        } catch (e) {
          this.log(`自检：打开面板失败（${e?.message || e}），结果可能不准`)
        }

        const r = await canary(b)
        this.state.selectors = {
          ok: r.ok,
          broken: r.broken,
          absent: r.absent,
          at: Date.now(),
          detail: r.working,
        }
        if (!r.ok) {
          this.log(`⚠️ 选择器自检失败：${r.broken.join(', ')} —— 抖音可能改版了`)
        } else {
          this.log(`选择器自检通过（${Object.keys(r.working).length} 项探测）`)
        }
        return r
      } finally {
        // ② 只把定时器装回去，**不调 start()**
        if (wasRunning && !this.timer) {
          const every = Math.max(5000, Number(this.cfg.pollIntervalMs) || 20000)
          this.timer = setInterval(() => { void this.pollOnce() }, every)
        }
      }
    } finally {
      BRIDGE_LOCK.selftest = false
    }
  }

  /** 打开浏览器到抖音首页，让用户自己扫码登录 */
  async openLogin() {
    // 🔴 用户明确要求开浏览器 ⇒ 解除「被关掉了」的锁，无条件重开
    this.browserClosed = false
    this._relaunchCount = 0
    this._relaunchAt = 0
    const b = await this.ensureBrowser({ relaunch: true })
    await b.goto('https://www.douyin.com/', { settleMs: 6000 })
    const st = await checkLogin(b)
    this.log(st.loggedIn ? '登录成功' : '已打开抖音，请扫码登录')
    return st
  }

  /* ── 会话（好友）列表 ─────────────────────────────────────────── */

  /** 要处理的好友：配置里指定的就用它，没指定就全部 */
  async targetPeers() {
    const cfgPeers = Array.isArray(this.cfg.peers) ? this.cfg.peers.filter(Boolean) : []
    if (cfgPeers.length) return cfgPeers
    const b = await this.ensureBrowser()
    const r = await dmList({ browser: b })
    if (!r.ok) return []
    return r.conversations.map((c) => c.name)
  }

  /** 允许分享视频给谁 */
  shareTargets() {
    const t = Array.isArray(this.cfg.sharePeers) ? this.cfg.sharePeers.filter(Boolean) : []
    if (t.length) return t
    return Array.isArray(this.cfg.peers) ? this.cfg.peers.filter(Boolean) : []
  }

  /* ── DSH 会话 ─────────────────────────────────────────────────── */

  /** 某个好友对应的 DSH session id（没有就空串） */
  sessionIdOf(peer) {
    return peerSession(this.map, peer)
  }

  /** 反查：某个 DSH session 是哪个好友的 */
  peerOfSession(sessionId) {
    for (const [peer, rec] of Object.entries(this.map.peers || {})) {
      if (rec && rec.sessionId === sessionId) return peer
    }
    return ''
  }

  /**
   * 桥接会话的模型参数。
   *
   * 🔴 必须显式给 provider + model。
   *    `agents.create()` 不会自动继承 profile 的默认模型 ——
   *    不给就是 turn/end reason=error「has no provider/model」，
   *    表现是「注入了、turn 建了、llmMs=0、什么都没发生」（异常还被 agent-loop 吞掉）。
   *    所以：配置里没写就自动去问宿主的 agent-default-model 服务。
   */
  agentOptions() {
    const o = {}
    const provider = this.cfg.provider || this.defaultModel()?.provider
    const model = this.cfg.model || this.defaultModel()?.model
    if (provider) o.provider = provider
    if (model) o.model = model
    const effort = this.cfg.reasoningEffort || this.defaultModel()?.reasoningEffort
    if (effort) o.reasoningEffort = effort
    return o
  }

  /**
   * 问宿主「默认用哪个模型」。
   *
   * profile 里配的是 `@deepseek-ai/dsh-agent-default-model`，
   * 它把选择记在 `agentDefaultModel` 服务上，读法是 `currentSelection()`
   * （返回 `{provider, model, reasoningEffort?}`）。
   * 读不到就返回 null，让调用方自己决定。
   */
  defaultModel() {
    if (this._defaultModel !== undefined) return this._defaultModel
    this._defaultModel = null

    const norm = (v) => {
      if (!v || typeof v !== 'object') return null
      const provider = v.provider ?? v.providerId ?? ''
      const model = v.model ?? v.modelId ?? ''
      if (!provider || !model) return null
      return { provider, model, reasoningEffort: v.reasoningEffort ?? '' }
    }

    const svc = this.service('agentDefaultModel')
    if (svc) {
      // ① 官方读法
      try {
        const got = norm(typeof svc.currentSelection === 'function' ? svc.currentSelection() : null)
        if (got) { this._defaultModel = got; return got }
      } catch { /* 试下一种 */ }
      // ② 值直接挂在服务上 / 藏在常见字段里
      for (const v of [svc, svc.current, svc.value, svc.selection, svc.resolved]) {
        const got = norm(v)
        if (got) { this._defaultModel = got; return got }
      }
    }
    return null
  }

  /** 拿到（或建起）这个好友的 DSH agent */
  async ensureAgent(peer) {
    const agents = this.service('agents')
    if (!agents) throw new Error('这个 DSH profile 里没有 agents 服务，桥接无法注入会话')

    const existing = peerSession(this.map, peer)
    if (existing) {
      const live = agents.get(existing)
      if (live) return live
      // 冷会话：把它从磁盘恢复回来
      try {
        const handle = await agents.resume({
          resumeSessionId: existing,
          agentOptions: this.agentOptions(),
          setup: async (agentCtx, agent) => { await this.applyPreset(agent); await this.runSetup(agentCtx, agent) },
        })
        this.log(`恢复会话 ${existing}（${peer}）`)
        return handle.agent
      } catch (e) {
        this.log(`恢复会话 ${existing} 失败：${e?.message || e} → 重建`)
      }
    }

    const id = `douyin-${sanitizeId(peer)}-${randomUUID().slice(0, 8)}`
    // ⚠️ cwd 必须是**用户的工作目录**，不能是 DSH profile 目录。
    //    桌面版进程的 process.cwd() 是 profile 目录，agent 在里面跑会
    //    ① 读不到用户项目的 AGENTS.md ② 会话文件落到奇怪的 workspace 下。
    //    优先用配置的 cwd，其次用户 home，最后才退回 process.cwd()。
    const cwd = this.cfg.cwd || homedir() || process.cwd()
    const opts = this.agentOptions()
    const handle = await agents.create({
      sessionId: id,
      meta: { cwd },
      agentOptions: opts,
      setup: async (agentCtx, agent) => { await this.applyPreset(agent); await this.runSetup(agentCtx, agent) },
    })
    const sessionId = handle?.agent?.id || id
    setPeerSession(this.map, peer, sessionId, { peer, createdAt: Date.now() })
    saveSessionMap(this.map)
    this.log(`新建 DSH 会话 ${sessionId}（${peer}，cwd=${cwd}，模型=${opts.provider || '默认'}/${opts.model || '默认'}）`)
    return handle.agent
  }

  /** 宿主挂的 setup 钩子（值班章程等） */
  async runSetup(agentCtx, agent) {
    if (typeof this.onSessionSetup !== 'function') return
    try {
      await this.onSessionSetup(agentCtx, agent)
    } catch (e) {
      this.log(`会话 setup 钩子出错：${e?.message || e}`)
    }
  }

  /** 给桥接会话套上 agent preset（可选；套不上不影响主流程） */
  async applyPreset(agent) {
    const preset = this.cfg.agentPreset
    if (!preset) return
    try {
      const presets = this.service('agentPresets')
      if (!presets) return
      await presets.select(agent, preset)
      this.log(`会话套用 preset：${preset}`)
    } catch (e) {
      this.log(`套 preset 失败（${preset}）：${e?.message || e}`)
    }
  }

  /* ── 注入 ──────────────────────────────────────────────────────── */

  /**
   * 把一张图片存进 DSH 的附件库，拿到可复用的引用。
   *
   * 这一步是「AI 真的能看见对方发的图」的关键 ——
   * 光在正文里写「[图片 200×150]」模型是看不见任何东西的。
   *
   * DSH 的接口（实测 @deepseek-ai/dsh-attachment）：
   *   `ctx.get('attachments')` → AttachmentStore
   *   `saveImages([{data: Uint8Array, mediaType, name?}])` → ImageAttachmentRef[]
   *   限制：单图 ≤ 20MB、单条消息图片总量 ≤ 200MB、
   *        类型只能是 image/png | jpeg | webp | gif
   *
   * @param {object} media 消息里的 media 字段
   * @returns {Promise<object|null>} ImageAttachmentRef
   */
  async saveImageAttachment(media) {
    if (!media?.data) return null
    // 优先用单独 inject 到的附件上下文，退回桥接自己的 ctx
    const att = (() => {
      try { return this.attCtx?.get?.('attachments') } catch { /* ignore */ }
    })() || this.service('attachments')
    if (!att) {
      this.log('DSH 里没有 attachments 服务，图片只能以文字形式出现')
      return null
    }
    const bytes = dataUrlToBytes(media.data)
    if (!bytes || !bytes.bytes?.length) return null
    if (!/^image\/(png|jpeg|webp|gif)$/.test(bytes.mediaType)) {
      this.log(`图片类型不支持：${bytes.mediaType}`)
      return null
    }
    try {
      const refs = await att.saveImages([{
        data: bytes.bytes,
        mediaType: bytes.mediaType,
        name: 'douyin-image.png',
      }])
      const ref = refs?.[0]
      if (ref) this.log(`图片已存进附件库（${bytes.bytes.length} 字节，${ref.width}×${ref.height}）`)
      return ref || null
    } catch (e) {
      this.log(`存图片失败：${e?.message || e}`)
      return null
    }
  }

  /**
   * 把一条抖音私信注入对应 DSH 会话，并唤醒 agent。
   *
   * @param {string} peer 好友名
   * @param {string} text 正文（媒体消息这里是描述，比如「[图片 200×150]」）
   * @param {object} media 媒体信息（带 data 的图片会被真的塞给模型看）
   */
  async inject(peer, text, media = null) {
    const body = String(text || '').trim()
    if (!body) return false
    const agent = await this.ensureAgent(peer)
    const limit = Number(this.cfg.maxInjectChars) || 4000
    const wrapped = `【抖音私信 · ${peer}】\n${body.slice(0, limit)}`
    const content = [{ type: 'text', text: wrapped }]

    // ⭐ 图片：存进附件库，作为 image 块挂上去 —— 模型能直接看图
    const ref = await this.saveImageAttachment(media)
    if (ref) content.push({ type: 'image', attachment: ref })

    const msg = await this.makeUserMessage({
      content,
      source: { kind: 'user', rpcId: `douyin-${randomUUID()}` },
    })

    // 🔴 followup 是「叫醒 agent 并把这条消息排进它的队列」。
    //    它是同步返回的（返回 boolean / void），真正的推理是异步跑的 ——
    //    所以要把它 await 掉，并在失败时把原因记下来，
    //    否则「注入成功」只是「消息塞进队列了」，会话里可能一个字都没有。
    try {
      const r = agent.followup(msg)
      if (r && typeof r.then === 'function') await r
    } catch (e) {
      this.log(`唤醒 agent 失败(${peer})：${e?.message || e}`)
      return false
    }

    this.state.injected++
    this.log(`注入 ${peer}：${body.slice(0, 40).replace(/\n/g, ' ')}`)
    return true
  }

  /* ── 轮询 ──────────────────────────────────────────────────────── */

  /**
   * 一轮里哪些是**新**消息。
   *
   * 为什么不能只靠「见过这条正文没有」：
   *   好友连发两个「1」，第二条会被指纹判成重复 ⇒ 永远注入不进去。
   *
   * 改成**窗口位移对比**：
   *   私信列表是一个滚动窗口，新消息从底部进来，旧消息从顶部滚出去。
   *   所以这一轮的窗口 = 上一轮窗口的某个后缀 + 新消息。
   *   找出最大的重合后缀，后面那段就是新的。
   *
   * @param {string[]} prev 上一轮的指纹序列（视觉顺序，旧→新）
   * @param {string[]} cur  这一轮的指纹序列
   * @returns {number} 从 cur 的哪个下标开始是新的
   */
  static newFrom(prev, cur) {
    if (!prev?.length || !cur?.length) return 0
    // 从「重合最多」开始试：prev 的后缀 == cur 的前缀
    for (let overlap = Math.min(prev.length, cur.length); overlap > 0; overlap--) {
      let same = true
      for (let i = 0; i < overlap; i++) {
        if (prev[prev.length - overlap + i] !== cur[i]) { same = false; break }
      }
      if (same) return overlap
    }
    return 0
  }

  /** 跑一轮：读每个好友的私信，把新消息注入 DSH */
  async pollOnce() {
    if (this.busy) return { skipped: 'busy' }
    if (this.cfg.mode === 'off') return { skipped: 'mode-off' }
    this.busy = true
    const started = Date.now()
    try {
      // 🔴 整轮加超时。
      //    抖音页面偶尔会卡住（转圈、风控弹窗、面板动画不走完），
      //    CDP 的 Runtime.evaluate 就会一直等下去 —— 而 busy 一旦卡住，
      //    后面所有轮询都返回 busy，桥接看起来「活着但什么都不做」。
      //    给整轮一个上限，超了就放弃这一轮，busy 照常释放。
      return await this.#pollWithTimeout(started)
    } finally {
      this.busy = false
    }
  }

  async #pollWithTimeout(started) {
    const LIMIT = Math.max(60000, Number(this.cfg.pollIntervalMs || 20000) * 4)
    let timer
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`这一轮超过 ${LIMIT}ms 没跑完（页面卡住了）`)), LIMIT)
    })
    try {
      return await Promise.race([this.#pollBody(started), timeout])
    } catch (e) {
      this.state.consecutiveErrors++
      this.state.lastError = String(e?.message || e)
      this.log(`轮询出错：${this.state.lastError}`)
      return { ok: false, error: this.state.lastError }
    } finally {
      clearTimeout(timer)
    }
  }

  async #pollBody(started) {
    let peers = []
    try {
      peers = await this.targetPeers()
    } catch (e) {
      // 浏览器被关掉了 / 刚崩了 —— 这一轮跳过，别把它当成致命错误
      const msg = String(e?.message || e).split('\n')[0]
      this.state.lastError = msg
      this.log(`本轮跳过：${msg}`)
      return { ok: false, error: msg, skipped: true }
    }
    const injected = []
    for (const peer of peers) {
      let r
      try {
        const b = await this.ensureBrowser()
        r = await readDM({ browser: b, uname: peer, limit: 20 })
      } catch (e) {
        this.log(`读私信失败(${peer})：${e?.message || e}`)
        continue
      }
      if (!r.ok) {
        this.log(`读私信失败(${peer})：${r.error || '未知原因'}`)
        continue
      }
      const rec = this.map.peers[peer] || (this.map.peers[peer] = {})
      const msgs = Array.isArray(r.messages) ? r.messages : []

      // 这一轮的窗口指纹（视觉顺序：旧 → 新）
      const cur = msgs.map((m) => fingerprint(peer, m))

      // ① 第一次见到这个好友 —— 只做基线，不灌历史
      if (!rec.seeded) {
        rec.window = cur
        for (const m of msgs) markSeen(this.map, peer, fingerprint(peer, m))
        rec.seeded = true
        rec.lastSeenAt = Date.now()
        this.log(`首次见到 ${peer}：已把 ${msgs.length} 条历史标为基线（不注入）`)
        continue
      }

      // ② 算新消息的起点
      const from = DouyinBridge.newFrom(rec.window, cur)
      rec.window = cur

      // ③ 从新消息里挑该注入的：不是自己发的、不是系统消息、不是分享卡片
      for (let i = from; i < msgs.length; i++) {
        const m = msgs[i]
        if (m.fromMe || m.system || m.unsupported || m.isShare) continue
        const fp = cur[i]
        // 兜底：窗口对比失效（比如中间被删了消息）时，用指纹挡一次
        if (from === 0 && hasSeen(this.map, peer, fp)) continue
        markSeen(this.map, peer, fp)
        try {
          await this.inject(peer, m.text, m.media)
          injected.push({ peer, text: String(m.text || '').slice(0, 60) })
        } catch (e) {
          this.log(`注入失败(${peer})：${e?.message || e}`)
        }
      }
      rec.lastSeenAt = Date.now()
    }

    saveSessionMap(this.map)
    this.state.polls++
    this.state.lastPollAt = Date.now()
    this.state.lastError = ''
    this.state.consecutiveErrors = 0
    await this.relayPending()
    return { ok: true, peers: peers.length, injected, ms: Date.now() - started }
  }

  /* ── 回流 ──────────────────────────────────────────────────────── */

  /**
   * 把 DSH 会话里新出现的 assistant 文本发回抖音。
   *
   * 只在 `mirror` 模式下自动发；`simulation` 模式下由 AI 自己调 `douyin_dm_send`。
   * 按 session 的 seq 去重，所以观察器和轮询两条路不会重复发。
   */
  async relayPending() {
    if (this.cfg.mode !== 'mirror') return []
    const sent = []
    for (const [peer, rec] of Object.entries(this.map.peers || {})) {
      if (!rec || !rec.sessionId) continue
      const session = this.service('sessions')?.get(rec.sessionId)
      if (!session) continue
      const last = Number(rec.lastRelayedSeq) || 0
      const events = session.snapshotEvents()
      for (const ev of events) {
        if (ev.seq <= last) continue
        if (ev.type !== 'assistant/message') continue
        rec.lastRelayedSeq = ev.seq
        const text = extractText(ev.data?.message?.content)
        if (!text) continue
        try {
          const b = await this.ensureBrowser()
          const r = await sendDM({ browser: b, text, uname: peer })
          if (r.ok) {
            this.state.sent++
            sent.push({ peer, text: text.slice(0, 40) })
            this.log(`回发 ${peer}：${text.slice(0, 40).replace(/\n/g, ' ')}`)
          } else {
            this.log(`回发失败(${peer})：${r.error || '未知原因'}`)
          }
        } catch (e) {
          this.log(`回发出错(${peer})：${e?.message || e}`)
        }
      }
    }
    if (sent.length) saveSessionMap(this.map)
    return sent
  }

  /** 会话事件观察器：assistant 一有输出就尽快回流（不靠等下一轮轮询） */
  attachObserver() {
    const handler = (session, event) => {
      if (!event) return
      // 🔴 agent 出错时 agent-loop 内部 `catch (_error) {}` 会把异常吞掉，
      //    表现就是「注入了、turn 建了、但 llmMs=0、什么都没发生」。
      //    只有这个事件能看到真实原因，必须记下来。
      if (event.type === 'agent/error') {
        const e = event.data?.error
        this.log(`agent 出错：${e?.message || String(e)}`)
        this.state.lastError = String(e?.message || e)
        return
      }
      if (event.type !== 'assistant/message') return
      const peer = this.peerOfSession(session?.id)
      if (!peer) return
      void this.relayPending()
    }
    const disposer = this.ctx.on('session/event', handler)
    return typeof disposer === 'function' ? disposer : () => {}
  }

  /**
   * 某个会话最近的事件（调试用）。
   *
   * agent-loop 内部 `catch (_error) {}` 会把异常吞掉，`llmMs: 0` 什么都不说明。
   * 这里把 session 的事件流读出来，才能看出到底卡在哪一步。
   */
  async recentEvents(sessionId, limit = 60) {
    const sid = sessionId || Object.values(this.map.peers || {}).map((r) => r?.sessionId).find(Boolean)
    if (!sid) return { error: '没有会话' }
    const sessions = this.service('sessions')
    const session = sessions?.get?.(sid)
    if (!session) return { error: `会话 ${sid} 不在内存里（agent 没起来）` }
    try {
      const events = session.snapshotEvents()
      return {
        sessionId: sid,
        total: events.length,
        events: events.slice(-limit).map((ev) => {
          const out = { type: ev.type, seq: ev.seq }
          const content = ev.data?.message?.content
          if (Array.isArray(content)) {
            out.content = content.map((b) => (b.type === 'text'
              ? `text:${String(b.text).slice(0, 120)}`
              : b.type === 'tool-call' ? `tool:${b.name}` : b.type))
          }
          if (ev.data?.reason !== undefined) out.reason = ev.data.reason
          if (ev.data?.error !== undefined) out.error = String(ev.data.error?.message ?? ev.data.error).slice(0, 300)
          return out
        }),
      }
    } catch (e) {
      return { error: String(e?.message || e) }
    }
  }

  /**
   * 读某个好友的**完整对话历史**。
   *
   * 🔴 关键认知：抖音网页版是虚拟列表，DOM 里只有最近一屏（约 20 条）。
   *    但**所有注入过的消息都已经落在 DSH 的 session 日志里了** ——
   *    那里才是完整、结构化、不受抖音改版影响的历史。
   *
   *    所以「读历史」不该去抖音翻，应该读 DSH。
   *
   * @param {string} peer 好友名
   * @param {number} limit 最多返回多少条
   */
  async history(peer, limit = 100) {
    const sid = this.sessionIdOf(peer)
    if (!sid) {
      return { ok: false, error: `${peer} 还没有对应的 DSH 会话（还没注入过消息）`, messages: [] }
    }

    const r = readDialog(sid, peer, limit)
    if (!r.ok) return { ok: false, error: r.error, messages: [] }

    return {
      ok: true,
      sessionId: sid,
      peer,
      total: r.total,
      messages: r.messages.map((m) => ({
        who: m.role === 'peer' ? peer : '我',
        text: m.text,
        time: m.time ? new Date(m.time).toLocaleString('zh-CN') : '',
      })),
      note: '从 DSH 会话日志里读的，比抖音 DOM 能看到的（约 20 条）完整',
    }
  }

  /* ── 生命周期 ──────────────────────────────────────────────────── */

  start({ relaunchBrowser = false } = {}) {
    // 🔴 插件被加载时调用 start() —— **不要**在这里解除「浏览器被关掉了」。
    //    否则每次 DSH 重载都会弹一个浏览器窗口出来（用户最烦的就是这个）。
    //    只有用户显式 POST /start 时才传 relaunchBrowser=true。
    if (relaunchBrowser) {
      this.browserClosed = false
      this._relaunchCount = 0
      this._relaunchAt = 0
    }
    // 抢轮询权：只有抢到的实例才真正跑定时器，别的实例静默退出。
    // （热重载时会有新旧两个实例并存，都跑会互相踩面板。）
    if (!this._instanceId) this._instanceId = ++BRIDGE_LOCK.seq
    if (BRIDGE_LOCK.owner && BRIDGE_LOCK.owner !== this._instanceId) {
      // 有更新的实例在跑 —— 让位，不启动
      return
    }

    // 🔴 抖动保护：短时间内反复启停，说明有僵尸实例在互相拉扯
    //    （热重载留下的旧 fiber，它的定时器还在跑旧代码）。
    //    这时候再跟着启停只会让日志刷屏，把真正的问题埋掉 —— 直接放弃。
    const now = Date.now()
    if (now - BRIDGE_LOCK.lastToggle < 2000) {
      BRIDGE_LOCK.toggles++
      if (BRIDGE_LOCK.toggles > 3) {
        if (!BRIDGE_LOCK.warned) {
          BRIDGE_LOCK.warned = true
          this.log('⚠️ 检测到频繁启停（多半是残留的旧插件实例）—— 建议重启 DSH 彻底清理')
        }
        return
      }
    } else {
      BRIDGE_LOCK.toggles = 0
    }
    BRIDGE_LOCK.lastToggle = now

    BRIDGE_LOCK.owner = this._instanceId

    this.stop()
    const every = Math.max(5000, Number(this.cfg.pollIntervalMs) || 20000)
    this.timer = setInterval(() => { void this.pollOnce() }, every)
    // 先跑一轮（不等一个周期）
    void this.pollOnce()
    this.log(`桥接已启动：每 ${every}ms 轮询一次，模式 ${this.cfg.mode}`)

    // ⚠️ 选择器自检**不自动跑**。
    //
    //    踩过的坑：把自检挂在 start() 里，它会调 ensurePanel 去开面板 ——
    //    而面板是 toggle，开/关会触发页面重渲染，进而引发新一轮轮询，
    //    轮询里的失败路径又调 start() ⇒ 无限循环，日志刷屏
    //    （「已停止 / 自检通过 / 已启动」每 5 秒一轮）。
    //
    //    自检是**排障工具**，不是常驻任务：
    //      · 手动：`douyin_selftest` 工具 / `POST /dsh-douyin-bridge/selftest`
    //      · 或 tools/probe-canary.mjs
    //    这样它不会干扰正常运行。
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      this.log('桥接已停止')
    }
  }

  /**
   * 卸载插件。
   *
   * 🔴 **不要关浏览器**。
   *    浏览器是「插件的浏览器」没错，但热重载时宿主会先卸旧实例再装新实例，
   *    旧实例一关浏览器，新实例刚连上的页面就没了 —— 表现为
   *    「面板没打开 / 进不去具体会话」，而且重载后要等一个轮询周期才恢复。
   *    浏览器留着，新实例直接 reuse，体验才连贯。
   *    （真要让浏览器退出，用户自己关窗口就行。）
   */
  async dispose() {
    this.stop()
    // 释放轮询权（让下一个实例能接手）
    if (BRIDGE_LOCK.owner === this._instanceId) BRIDGE_LOCK.owner = 0
    // 停掉累积器（不然它会一直打 CDP）
    if (this._collector) {
      try { this._collector() } catch { /* 忽略 */ }
      this._collector = null
    }
    // 只断连接，不杀进程
    try { this.browser?.detach?.() } catch { /* 忽略 */ }
    this.browser = null
  }

  /* ── 状态 ──────────────────────────────────────────────────────── */

  /**
   * 列出宿主认识���模型（带「支不支持图像」）。
   *
   * ⭐ 这是「AI 到底看不看得见对方发的图」的关键：
   *    DSH 的 llm 层会看 `inputModalities` ——
   *    没有 "image" 就把图片块降级成一句
   *    「[image omitted because this model accepts text only; …]」，
   *    模型只能看到一串 sha，**看不见图**。
   *
   * @param {string} provider 不填 = 列出所有 provider
   */
  async listModels(provider = '') {
    const llm = this.service('llm')
    if (!llm) return { ok: false, error: '这个 profile 里没有 llm 服务' }
    const providers = provider ? [provider] : this.knownProviders()
    const out = []
    for (const p of providers) {
      try {
        const models = await llm.listModels(p)
        for (const m of (models || [])) {
          const input = Array.isArray(m.inputModalities) ? m.inputModalities : []
          out.push({
            provider: p,
            model: m.id,
            name: m.name || m.id,
            input: input.join('+') || '?',
            canSeeImage: input.includes('image'),
          })
        }
      } catch (e) {
        out.push({ provider: p, error: String(e?.message || e) })
      }
    }
    out.sort((a, b) => (a.provider === b.provider ? 0 : a.provider < b.provider ? -1 : 1))
    return { ok: true, count: out.length, models: out }
  }

  /** 从配置里猜出可能用到的 provider（配置里写了优先） */
  knownProviders() {
    const list = []
    const add = (p) => { if (p && !list.includes(p)) list.push(p) }
    add(this.cfg.provider)
    const dm = this.defaultModel()
    add(dm?.provider)
    for (const p of ['minimax-cn', 'minimax', 'openai', 'anthropic', 'google', 'zai-coding-cn']) add(p)
    return list
  }

  status() {
    const model = this.defaultModel()
    return {
      enabled: this.cfg.enabled,
      mode: this.cfg.mode,
      peers: Array.isArray(this.cfg.peers) ? this.cfg.peers : [],
      sharePeers: Array.isArray(this.cfg.sharePeers) ? this.cfg.sharePeers : [],
      pollIntervalMs: this.cfg.pollIntervalMs,
      running: Boolean(this.timer),
      browserReady: Boolean(this.browser?.ready),
      /** 🔴 浏览器是不是被用户关掉了（关掉之后不会再自动弹窗口） */
      browserClosed: Boolean(this.browserClosed),
      browserAlive: Boolean(this.browser?.isAlive?.()),
      // ⭐ 桥接会话用的模型。
      //    ⚠️ **图片要模型支持才看得见**：文本模型收到 image 块也只能看到一串
      //    sha（它会自己说「我这边看不清图」）。
      //    视觉模型（input 里带 image 的）才能真的看图。
      agentModel: {
        provider: this.cfg.provider || model?.provider || '',
        model: this.cfg.model || model?.model || '',
      },
      attachments: Boolean(this.service('attachments') || this.attCtx?.get?.('attachments')),
      sessions: Object.fromEntries(
        Object.entries(this.map.peers || {}).map(([p, r]) => [p, r.sessionId]),
      ),
      ...this.state,
    }
  }
}

export { sleep }

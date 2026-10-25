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
import { getBrowser, findBrowser, cleanLocks } from './browser.mjs'
import { dmList, readDM, sendDM, checkLogin } from './douyin.mjs'
import { loadHostDeps } from './hostdeps.mjs'
import {
  loadConfig, saveConfig, loadSessionMap, saveSessionMap,
  peerSession, setPeerSession, hasSeen, markSeen, fingerprint, appendLog,
} from './state.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

  async ensureBrowser() {
    if (this.browser && this.browser.ready) return this.browser
    cleanLocks(this.cfg.userDataDir)
    this.browser = await getBrowser({
      exe: this.cfg.browser || findBrowser(),
      userDataDir: this.cfg.userDataDir,
      port: this.cfg.browserPort,
      log: (m) => this.log(`浏览器：${m}`),
      reuse: true,
    })
    return this.browser
  }

  async loginStatus() {
    const b = await this.ensureBrowser()
    const r = await checkLogin(b)
    return { ...r, browser: this.browser?.exe || '', profile: this.cfg.userDataDir }
  }

  /** 打开浏览器到抖音首页，让用户自己扫码登录 */
  async openLogin() {
    const b = await this.ensureBrowser()
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

  /** 把一条抖音私信注入对应 DSH 会话，并唤醒 agent */
  async inject(peer, text) {
    const body = String(text || '').trim()
    if (!body) return false
    const agent = await this.ensureAgent(peer)
    const limit = Number(this.cfg.maxInjectChars) || 4000
    const wrapped = `【抖音私信 · ${peer}】\n${body.slice(0, limit)}`
    const msg = await this.makeUserMessage({
      content: [{ type: 'text', text: wrapped }],
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
    const peers = await this.targetPeers()
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
          await this.inject(peer, m.text)
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

  /* ── 生命周期 ──────────────────────────────────────────────────── */

  start() {
    this.stop()
    const every = Math.max(5000, Number(this.cfg.pollIntervalMs) || 20000)
    this.timer = setInterval(() => { void this.pollOnce() }, every)
    // 先跑一轮（不等一个周期）
    void this.pollOnce()
    this.log(`桥接已启动：每 ${every}ms 轮询一次，模式 ${this.cfg.mode}`)
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
    // 只断连接，不杀进程
    try { this.browser?.detach?.() } catch { /* 忽略 */ }
    this.browser = null
  }

  /* ── 状态 ──────────────────────────────────────────────────────── */

  status() {
    return {
      enabled: this.cfg.enabled,
      mode: this.cfg.mode,
      peers: Array.isArray(this.cfg.peers) ? this.cfg.peers : [],
      sharePeers: Array.isArray(this.cfg.sharePeers) ? this.cfg.sharePeers : [],
      pollIntervalMs: this.cfg.pollIntervalMs,
      running: Boolean(this.timer),
      browserReady: Boolean(this.browser?.ready),
      sessions: Object.fromEntries(
        Object.entries(this.map.peers || {}).map(([p, r]) => [p, r.sessionId]),
      ),
      ...this.state,
    }
  }
}

export { sleep }

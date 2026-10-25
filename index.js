/**
 * dsh-douyin-bridge —— 抖音私信 ⇄ DSH 会话
 * ============================================================================
 * 这是「相当于 SnowLuma 的那一层」，只不过桥的是**抖音私信**而不是 QQ。
 *
 *   抖音私信 ──读──▶ 桥 ──注入──▶ DSH 会话 ──▶ LLM
 *        ▲                                │
 *        └──────── 发送 ◀── LLM 调工具 ────┘
 *
 * 两条腿：
 *   ① **工具腿**（给 LLM 用）：`douyin_*` 一组工具 —— 搜、读详情、分享、
 *      列会话、读私信、发私信、看状态。LLM 通过 DSH 调它们完成「刷视频、
 *      分享到私信、聊天」的整套流程。
 *   ② **桥腿**（自动的）：定时读抖音私信，把新消息**注入对应的 DSH 会话**，
 *      唤醒 agent。所有对话内容都落在 DSH 的 session 日志里。
 *
 * 🔴 工具定义为什么不用 `defineTool`：
 *   `@deepseek-ai/dsh-tools` 在桌面版 profile 里是 optional peer ⇒ pnpm 永远
 *   不装 ⇒ 裸 import 会让整条插件不激活（`failed to import`）。
 *   而 `defineTool` 干的活无非是「把参数规格转成 JSON Schema + 执行前校验」。
 *   我们直接把**原始 JSON Schema** 写进 `parameters` 再 `ctx.tools.register`，
 *   就完全不需要那个包了 —— 参数校验自己写（下面每个工具都做了）。
 * ============================================================================
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { DouyinBridge } from './lib/bridge.mjs'
import { search, detail, share, dmList, readDM, sendDM } from './lib/douyin.mjs'
import { loadConfig, saveConfig, tailLog, paths } from './lib/state.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * 写一份诊断快照到 `<家目录>/diag.json`。
 *
 * 插件在宿主里的状态不好从外面看（桌面版的日志不进文件），
 * 所以把「服务有没有、路由挂上没有、工具注册了几个」落到一个文件里，排障时直接看它。
 *
 * ⚠️ 故意放在 index.js 里，不放 lib/state.mjs：宿主热重载时只换入口模块，
 *    依赖模块可能还是旧缓存 —— 新加的导出会在链接期炸掉。
 */
const writeDiag = (data) => {
  try {
    const dir = paths.dir
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = join(dir, 'diag.json')
    let prev = {}
    try { prev = JSON.parse(readFileSync(file, 'utf8')) } catch { /* 没有就当空的 */ }
    writeFileSync(file, JSON.stringify({ ...prev, ...data, at: new Date().toISOString() }, null, 2))
  } catch { /* 诊断写不进去也不能影响主流程 */ }
}

export const name = 'douyin-bridge'

/** 只硬依赖 tools；agent / session 服务用 ctx.inject 按需挂载 */
export const inject = ['tools']

export const Config = z.object({
  /** 桥接总开关（关掉后只留工具，不做任何自动注入） */
  enabled: z.boolean().default(true),
  /** 私信轮询间隔（毫秒） */
  pollIntervalMs: z.number().min(5000).max(600000).step(1).default(20000),
  /** 会话模式：simulation（AI 自己决定回不回） / mirror（自动回发） / off */
  mode: z.union([
    z.const('simulation'), z.const('mirror'), z.const('off'),
  ]).default('simulation'),
  /** 只处理这些好友的私信；空 = 全部 */
  peers: z.array(z.string()).default([]),
  /** 允许把视频分享给谁；空 = 跟随 peers */
  sharePeers: z.array(z.string()).default([]),
  /** 收到新消息时自动唤醒 agent */
  autoReply: z.boolean().default(true),
  /** 每条注入消息的字符上限 */
  maxInjectChars: z.number().min(200).max(20000).step(1).default(4000),
})

/* ── 工具输出的统一形状 ─────────────────────────────────────────────── */

const TEXT_OUTPUT = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

/** 宿主只吃无损 JSON */
const safe = (v) => {
  if (v === undefined || v === null) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
}

const str = (v, dflt = '') => (v === undefined || v === null ? dflt : String(v))
const num = (v, dflt = 0, lo = -Infinity, hi = Infinity) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}

/* ── 值班章程（给 agent 看的） ───────────────────────────────────────── */

/**
 * 章程正文来自 `prompts/duty.md`，用户可以改。
 * 读不到就用内置的兜底版本（插件本体不会因为缺文件就不工作）。
 */
function dutyText() {
  return readPrompt('duty.md', [
    '# 抖音值班章程',
    '',
    '你在抖音私信里当一个真人朋友，不是助手、不是客服。',
    '',
    '## 拿到一条私信时',
    '1. 先想清楚对方在说什么，别急着回。',
    '2. 要回就用 `douyin_dm_send`；不说点什么就别回。',
    '3. 一次只发一两条，别长篇大论。',
    '',
    '## 刷视频时',
    '1. `douyin_search` 搜 → `douyin_detail` 读完整文案 → 判断值不值得占用一次注意力。',
    '2. 真值得，用 `douyin_share` 分享过去，可以捎一句话（note）。',
    '3. 不值得就跳过，不要硬凑。',
  ].join('\n'))
}

/** 人格卡：抖音私信里的「我」是谁 */
function personaText() {
  return readPrompt('persona.md', [
    '你是大肥鱼，一个爱刷抖音的普通朋友，在抖音上跟人聊天。',
    '短句为主，不用 Markdown，不主动强调自己是 AI，'
    + '需要刷视频、分享、发消息时用 `douyin_*` 工具。',
  ].join('\n'))
}

/** 读插件目录下的 prompts/<file>，读不到给兜底 */
function readPrompt(file, fallback) {
  try {
    const p = join(__dirname, 'prompts', file)
    if (existsSync(p)) {
      const t = readFileSync(p, 'utf8')
      if (t.trim()) return t
    }
  } catch { /* 忽略 */ }
  return fallback
}

/* ── 插件主体 ───────────────────────────────────────────────────────── */

export function apply(ctx, config) {
  const log = (m) => {
    try { ctx.logger.info(`[douyin-bridge] ${m}`) } catch { /* 日志不能炸主流程 */ }
  }

  const cfg = {
    ...loadConfig(),
    ...(config || {}),
  }

  const bridge = new DouyinBridge({ ctx, log })
  bridge.cfg = { ...bridge.cfg, ...cfg }

  /* ── 工具 ─────────────────────────────────────────────────────── */

  /** 这个会话（agent）对应哪个好友 */
  const peerOfExec = (exec) => {
    const sid = exec?.agent?.id || ''
    return sid ? bridge.peerOfSession(sid) : ''
  }

  /** 允许发消息/分享给谁 */
  const allowedPeers = () => {
    const list = Array.isArray(bridge.cfg.peers) ? bridge.cfg.peers.filter(Boolean) : []
    if (list.length) return list
    return null        // null = 不限
  }

  const checkTarget = (target, what) => {
    const allow = allowedPeers()
    if (!allow) return ''
    const t = String(target || '').trim()
    if (!t) return `${what}没指定，但当前只允许发给：${allow.join('、')}`
    if (!allow.some((p) => p.includes(t) || t.includes(p))) {
      return `${what}「${t}」不在允许名单里（允许：${allow.join('、')}）`
    }
    return ''
  }

  const tools = [
    {
      name: 'douyin_whoami',
      description: '看抖音那边登录的是谁（登录态是否有效）。第一次用要先在设置页点「打开浏览器登录」。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT,
      async execute() {
        return safe(await bridge.loginStatus())
      },
    },

    {
      name: 'douyin_login',
      description: '打开抖音首页的浏览器窗口，让人扫码登录。登录完成后这个窗口会一直留着，不要关。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT,
      async execute() {
        return safe(await bridge.openLogin())
      },
    },

    {
      name: 'douyin_search',
      description: '搜抖音视频。返回标题 / 作者 / 时长 / 点赞 / 视频 id 等。\n'
        + '⚠️ 刷一轮的用法：搜完**一定再用 douyin_detail 读完整文案**再判断，别看标题就下结论。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索关键词' },
          limit: { type: 'number', description: '返回几条（默认 20，最大 50）' },
        },
        required: ['keyword'],
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const keyword = str(args.keyword).trim()
        if (!keyword) return { ok: false, error: '关键词是空的' }
        const b = await bridge.ensureBrowser()
        const r = await search({ browser: b, keyword, limit: num(args.limit, 20, 1, 50) })
        return safe(r)
      },
    },

    {
      name: 'douyin_detail',
      description: '读一个视频的详情：标题、**完整文案正文**、作者、时长、发布时间、点赞评论转发、话题标签。\n'
        + '⭐ 判断内容值不值得分享就靠这个 —— 一定要读，别只看搜索结果里的标题。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '视频 id（douyin_detail / douyin_search 返回的 id）' },
          commentLimit: { type: 'number', description: '取几条热门评论（默认 20，0 = 不取）' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const id = str(args.id).trim()
        if (!id) return { ok: false, error: '没有视频 id' }
        const b = await bridge.ensureBrowser()
        const r = await detail({ browser: b, id, commentLimit: num(args.commentLimit, 20, 0, 50) })
        return safe(r)
      },
    },

    {
      name: 'douyin_share',
      description: '把一个视频分享到某个好友的私信。\n'
        + '· `to` 留空 = 当前这个会话对应的好友（**聊天时最常用**）\n'
        + '· `note` = 捎一句话（视频卡片 + 你的话一起发过去）\n'
        + '· 分享成功后对方那边会看到视频卡片；捎句话失败不影响卡片本身。\n'
        + '⚠️ 必须先 douyin_detail 读过内容再分享，别盲转。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '视频 id' },
          to: { type: 'string', description: '分享给谁（好友名，留空 = 当前会话的好友）' },
          note: { type: 'string', description: '捎一句话（可空）' },
          dryRun: { type: 'boolean', description: '只查面板里有没有这个人，不真发' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const id = str(args.id).trim()
        if (!id) return { ok: false, error: '没有视频 id' }
        const to = str(args.to).trim() || peerOfExec(exec)
        if (!to) return { ok: false, error: '不知道分享给谁：要么指定 to，要么在某个好友的会话里调用' }
        const bad = checkTarget(to, '分享目标')
        if (bad) return { ok: false, error: bad }
        const b = await bridge.ensureBrowser()
        const r = await share({
          browser: b,
          id,
          to,
          dryRun: Boolean(args.dryRun),
          note: str(args.note).trim(),
        })
        return safe(r)
      },
    },

    {
      name: 'douyin_dm_list',
      description: '列出抖音私信会话（好友名 / 最后一条预览 / 时间 / 有没有未读）。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: '最多列几条（默认 40）' } },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const b = await bridge.ensureBrowser()
        const r = await dmList({ browser: b, limit: num(args.limit, 40, 1, 100) })
        return safe(r)
      },
    },

    {
      name: 'douyin_dm_read',
      description: '读某个好友的私信（会切到那个会话）。返回消息列表，每条标了是不是自己发的。\n'
        + '⚠️ 抖音是虚拟列表，默认只有最近一屏；要更多历史传 scrollBack。',
      parameters: {
        type: 'object',
        properties: {
          peer: { type: 'string', description: '好友名（留空 = 当前会话的好友）' },
          limit: { type: 'number', description: '最多返回几条（默认 30）' },
          scrollBack: { type: 'number', description: '往上滚几次加载历史（0 = 不滚）' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const peer = str(args.peer).trim() || peerOfExec(exec)
        if (!peer) return { ok: false, error: '不知道读谁的私信：指定 peer，或在某个好友的会话里调用' }
        const b = await bridge.ensureBrowser()
        const r = await readDM({
          browser: b,
          uname: peer,
          limit: num(args.limit, 30, 1, 100),
          scrollBack: num(args.scrollBack, 0, 0, 20),
        })
        return safe(r)
      },
    },

    {
      name: 'douyin_dm_send',
      description: '给某个好友发一条抖音私信。\n'
        + '· `to` 留空 = 当前这个会话对应的好友（**聊天时最常用**）\n'
        + '· 一次发一条。想分多条就调多次。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要发的正文' },
          to: { type: 'string', description: '发给谁（好友名，留空 = 当前会话的好友）' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const text = str(args.text).trim()
        if (!text) return { ok: false, error: '正文是空的' }
        const to = str(args.to).trim() || peerOfExec(exec)
        if (!to) return { ok: false, error: '不知道发给谁：要么指定 to，要么在某个好友的会话里调用' }
        const bad = checkTarget(to, '发送目标')
        if (bad) return { ok: false, error: bad }
        const b = await bridge.ensureBrowser()
        const r = await sendDM({ browser: b, text, uname: to })
        return safe(r)
      },
    },

    {
      name: 'douyin_duty',
      description: '读「值班章程」——你在这个桥里该守的规矩（怎么回话、什么时候分享、什么不做）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT,
      async execute() {
        return { text: dutyText() }
      },
    },

    {
      name: 'douyin_status',
      description: '看桥接现在的状态：有没有在跑、上次轮询什么时候、注入了多少条、'
        + '每个好友对应哪个 DSH 会话、有没有报错。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT,
      async execute() {
        return safe({ ...bridge.status(), config: bridge.cfg, log: tailLog(20) })
      },
    },

    {
      name: 'douyin_selftest',
      description: '抖音选择器自检。工具「返回成功但什么都没发生」时先跑这个：'
        + '它会逐个探测会话项 / 消息容器 / 输入框这些关键选择器，'
        + '告诉你哪条降级链还在生效、哪条全挂了（多半是抖音改版）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT,
      async execute() {
        return safe(await bridge.selectorCheck())
      },
    },

    {
      name: 'douyin_history',
      description: '读某个好友的**完整对话历史**。'
        + '这些是从 DSH 自己的会话日志里读的，比在抖音页面上翻（只能看到最近约 20 条）'
        + '完整得多，而且不受抖音改版影响。想知道「之前聊过什么」就用这个，别去翻抖音。',
      parameters: {
        type: 'object',
        properties: {
          peer: { type: 'string', description: '好友名。留空 = 当前会话对应的好友' },
          limit: { type: 'number', description: '最多返回多少条（默认 100）' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const peer = str(args.peer) || peerOfExec(exec)
        if (!peer) return { ok: false, error: '不知道读谁的历史：给 peer，或在好友的会话里调用' }
        return safe(await bridge.history(peer, num(args.limit, 100)))
      },
    },
  ]

  const disposers = []
  for (const t of tools) {
    const d = ctx.tools.register({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      output: t.output,
      async execute(args, exec) {
        try {
          return safe(await t.execute(args || {}, exec || {}))
        } catch (e) {
          const msg = String(e?.message || e)
          log(`工具 ${t.name} 出错：${msg}`)
          return { ok: false, error: msg }
        }
      },
    })
    disposers.push(d)
  }
  ctx.effect(() => () => { for (const d of disposers) { try { d() } catch { /* 忽略 */ } } }, 'douyin-bridge: tools')

  writeDiag({
    phase: 'tools-registered',
    tools: tools.map((t) => t.name),
    // ⚠️ 只能读**声明过 inject 的**服务：DSH 的 cordis 会拦未声明的服务访问
    //    （`cannot get property "agents" without inject`），整个插件直接不激活。
    //    这里用 ctx.get() 这种「读不到就 undefined」的写法，不碰 ctx.agents。
    services: {
      tools: Boolean(ctx.tools),
      agents: Boolean(ctx.get('agents')),
      sessions: Boolean(ctx.get('sessions')),
      webServer: Boolean(ctx.get('webServer')),
      systemPrompt: Boolean(ctx.get('systemPrompt')),
    },
    stateDir: paths.dir,
  })

  /* ── 桥腿（自动注入 + 回流） ─────────────────────────────────── */

  // agent / session 服务要 profile 里有才挂；没有就只留工具。
  //
  // ⚠️ 回调收到的 `scoped` 是**注入了 agents/sessions 的子上下文**：
  //    只有它上面才能读 `scoped.agents` / `scoped.sessions`。
  //    插件自己的 ctx 上直接读会报 `cannot get property "agents" without inject`，
  //    插件就整个不激活了 —— 所以桥接腿必须拿 scoped 里的 ctx。
  ctx.inject(['agents', 'sessions'], (scoped) => {
    // 桥接腿要用 agents/sessions：把注入了服务的 scoped 交给它
    bridge.setCtx(scoped)
    // 人格卡 + 值班章程挂进**桥接会话**的系统提示（只影响桥接会话，不污染别的会话）
    bridge.onSessionSetup = async (agentCtx) => {
      const sections = [
        { name: 'douyin-bridge:persona', order: 900, text: personaText() },
        { name: 'douyin-bridge:duty', order: 1000, text: dutyText() },
      ]
      for (const s of sections) {
        try {
          agentCtx.systemPrompt.section(s)
        } catch (e) {
          log(`挂系统提示段失败（${s.name}）：${e?.message || e}`)
        }
      }
    }

    // 🔴 这里必须用 `scoped.effect`，不能用外层的 `ctx.effect`。
    //    外层 ctx 的 fiber 在 inject 回调执行时可能已经「inactive」，
    //    在它上面注册 effect 会报 `cannot create effect on inactive context`，
    //    而且这个错误只在日志里出现一次，插件看起来正常但观察器/轮询都没挂上。
    scoped.effect(() => {
      const off = bridge.attachObserver()
      return off
    }, 'douyin-bridge: session observer')

    scoped.effect(async function* () {
      if (!bridge.cfg.enabled) {
        log('桥接被配置关掉了（enabled=false），只提供工具')
        return
      }
      if (bridge.cfg.mode === 'off') {
        log('桥接模式 = off：不做自动注入，只提供工具')
        return
      }
      bridge.start()
      yield () => { void bridge.dispose() }
    }, 'douyin-bridge: 轮询')

    log('插件已装载：工具 ' + tools.map((t) => t.name).join(', '))
  })

  /* ── 设置页用的 HTTP 接口 ─────────────────────────────────────── */

  // 只接受同源请求：别的网页在你浏览器里也能打到 127.0.0.1，
  // 所以要比对 sec-fetch-site 与 Origin/Host。
  // 桌面版是 Electron，页面可能来自 app:// 之类的自定义协议，
  // 那时 Origin 的 host 跟请求的 Host 对不上，所以只在 http(s) 时才严格比对。
  const sameOriginOk = (req) => {
    try {
      const site = String(req.headers?.['sec-fetch-site'] || '').toLowerCase()
      if (site === 'cross-site') return false
      const host = String(req.headers?.host || '').trim()
      const origin = String(req.headers?.origin || '').trim()
      if (!origin) return true
      if (origin === 'null') return false
      let u
      try { u = new URL(origin) } catch { return false }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return true
      if (!host) return false
      return u.host.toLowerCase() === host.toLowerCase()
    } catch { return false }
  }

  const sendJson = (res, code, obj) => {
    try {
      const body = JSON.stringify(obj)
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(body)
    } catch { /* 忽略 */ }
  }

  const readBody = async (req) => {
    try {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const raw = Buffer.concat(chunks).toString('utf8')
      return raw ? JSON.parse(raw) : {}
    } catch { return {} }
  }

  try {
    ctx.inject(['webServer'], (host) => {
      writeDiag({ phase: 'webserver-injected', webServerPort: host?.webServer?.port ?? null })
      host.effect(() => host.webServer.register({
        kind: 'prefix',
        // ⚠️ 不能挂在 /api 下：`/api/*` 归 DSH 的 API 网关管，
        //    网关认不出的 API 路径会直接 404，插件自己的路由根本轮不到。
        //    所以跟 dsh-purge 一样挂在根路径。
        path: '/dsh-douyin-bridge',
        handler: async (req, res) => {
          if (!sameOriginOk(req)) {
            sendJson(res, 403, { ok: false, error: '只接受同源请求' })
            return
          }
          const url = new URL(req.url, 'http://127.0.0.1')
          const p = url.pathname.replace(/^\/dsh-douyin-bridge/, '') || '/'
          try {
            if (req.method === 'GET' && p === '/status') {
              sendJson(res, 200, { ok: true, status: bridge.status(), config: bridge.cfg })
              return
            }
            if (req.method === 'GET' && p === '/log') {
              sendJson(res, 200, { ok: true, log: tailLog(80) })
              return
            }
            if (req.method === 'POST' && p === '/config') {
              const body = await readBody(req)
              const cfg = bridge.updateConfig(body)
              sendJson(res, 200, { ok: true, config: cfg })
              return
            }
            if (req.method === 'POST' && p === '/login') {
              sendJson(res, 200, { ok: true, status: await bridge.openLogin() })
              return
            }
            if (req.method === 'POST' && p === '/start') {
              bridge.start()
              sendJson(res, 200, { ok: true, status: bridge.status() })
              return
            }
            if (req.method === 'POST' && p === '/stop') {
              bridge.stop()
              sendJson(res, 200, { ok: true, status: bridge.status() })
              return
            }
            if (req.method === 'POST' && p === '/poll') {
              sendJson(res, 200, { ok: true, result: await bridge.pollOnce() })
              return
            }
            // 选择器自检：抖音改版时用它确认「哪条降级链挂了」
            if (req.method === 'POST' && p === '/selftest') {
              sendJson(res, 200, { ok: true, result: await bridge.selectorCheck() })
              return
            }
            // 读某个好友的完整对话历史（从 DSH 会话日志，不是抖音）
            if (req.method === 'GET' && p === '/history') {
              const peer = url.searchParams.get('peer') || ''
              const limit = Number(url.searchParams.get('limit')) || 100
              if (!peer) {
                sendJson(res, 400, { ok: false, error: '要 peer 参数' })
                return
              }
              sendJson(res, 200, { ok: true, result: await bridge.history(peer, limit) })
              return
            }
            // 调试用：绕过抖音，直接把一段文本注入某个好友的会话。
            // 用来单独验证「注入 → LLM 回复」这条链路，不被浏览器状态干扰。
            if (req.method === 'POST' && p === '/inject') {
              const body = await readBody(req)
              const peer = String(body.peer || '').trim()
              const text = String(body.text || '').trim()
              if (!peer || !text) {
                sendJson(res, 400, { ok: false, error: '要 peer 和 text' })
                return
              }
              const ok = await bridge.inject(peer, text)
              sendJson(res, 200, { ok, sessionId: bridge.sessionIdOf(peer), status: bridge.status() })
              return
            }
            // 调试用：这个会话最近的事件（看 LLM 到底回了什么）
            if (req.method === 'GET' && p === '/events') {
              const sid = url.searchParams.get('sessionId') || ''
              sendJson(res, 200, { ok: true, events: await bridge.recentEvents(sid) })
              return
            }
            sendJson(res, 404, { ok: false, error: '没有这个接口' })
          } catch (e) {
            sendJson(res, 500, { ok: false, error: String(e?.message || e) })
          }
        },
      }), 'douyin-bridge: /dsh-douyin-bridge 路由')
    })
  } catch (e) {
    log(`HTTP 路由没挂上：${e?.message || e}`)
    writeDiag({ phase: 'webserver-failed', error: String(e?.message || e) })
  }

  return () => {
    for (const d of disposers) { try { d() } catch { /* 忽略 */ } }
    void bridge.dispose()
  }
}

export { paths, saveConfig }

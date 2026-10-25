/**
 * lib/state.mjs —— 配置、状态目录、会话映射
 * ============================================================================
 * 规矩（跟 dsh-bili-scroll 一致）：
 *   · **所有配置与运行数据都写在 `$DSH_HOME/douyin-bridge/`，不写进插件包目录**
 *     （插件升级/重装不该弄丢你的登录态和会话映射）
 *   · 会话数据本体在 **DSH 的 session 日志**里；这里只存
 *     「聊天对象 ↔ DSH session id」的**映射**和**去重指纹**——
 *     这两样是索引，不是内容。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

/** DSH home：凭据、profile、session 日志都在这里 */
export function resolveDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 本插件的家目录 */
export function stateDir() {
  return join(resolveDshHome(), 'douyin-bridge')
}

export const paths = {
  dir: stateDir(),
  config: join(stateDir(), 'config.json'),
  sessions: join(stateDir(), 'sessions.json'),
  profile: join(stateDir(), 'profile'),
  log: join(stateDir(), 'bridge.log'),
  shots: join(stateDir(), 'shots'),
}

/**
 * ⚠️ 这个文件在插件热重载时**不一定会被重新导入**（宿主只换入口模块，
 * 依赖模块可能还是旧的缓存）。所以：
 *   · 别在这里加 index.js 依赖的新导出（会撞「没有这个导出」的链接期报错）
 *   · 需要新东西，要么放进 index.js 自己，要么改完把插件整个重装一遍
 */

export const DEFAULTS = {
  /** 桥接总开关 */
  enabled: true,
  /** 浏览器可执行文件；空 = 自动找 Edge/Chrome */
  browser: '',
  /** CDP 端口 */
  browserPort: 47881,
  /** 浏览器用户数据目录；空 = <家目录>/profile */
  userDataDir: '',
  /** 私信轮询间隔（毫秒） */
  pollIntervalMs: 20000,
  /** 会话模式：
   *   simulation —— 好友的消息注入 DSH 会话；**由 AI 自己决定要不要回、用什么工具回**
   *   mirror     —— simulation + agent 的文本回复自动发回抖音
   *   off        —— 只提供工具，不做任何自动注入 */
  mode: 'simulation',
  /** 只处理这些好友的私信；空数组 = 全部 */
  peers: [],
  /** 允许把视频分享给谁；空 = 跟随 peers */
  sharePeers: [],
  /** 收到新消息时自动唤醒 agent */
  autoReply: true,
  /** 每条注入消息的字符上限 */
  maxInjectChars: 4000,
  /** 桥接会话的工作目录；空 = DSH 进程当前目录 */
  cwd: '',
  /** 注入消息时附带的角色提示（人格卡） */
  personaFile: 'persona.md',
  /** 桥接会话用哪个 agent preset（空 = 用 DSH 默认） */
  agentPreset: '',
  /** 桥接会话的模型（空 = 用 DSH 默认） */
  provider: '',
  model: '',
  reasoningEffort: '',
}

function ensureDir() {
  for (const d of [paths.dir, paths.profile, paths.shots]) {
    try { mkdirSync(d, { recursive: true }) } catch { /* 忽略 */ }
  }
}

/** 读配置（缺字段用默认值补齐；文件坏了就退回默认值，不让插件起不来） */
export function loadConfig() {
  ensureDir()
  let raw = {}
  try {
    if (existsSync(paths.config)) raw = JSON.parse(readFileSync(paths.config, 'utf8')) || {}
  } catch { raw = {} }
  const cfg = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS)) {
    if (raw[k] !== undefined) cfg[k] = raw[k]
  }
  if (!cfg.userDataDir) cfg.userDataDir = paths.profile
  return cfg
}

/** 写配置（原子写：先写 .tmp 再改名，避免半截文件） */
export function saveConfig(cfg) {
  ensureDir()
  const tmp = paths.config + '.tmp'
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  renameSync(tmp, paths.config)
  return cfg
}

/* ── 会话映射 ──────────────────────────────────────────────────────── */

const emptyMap = () => ({ version: 1, peers: {}, seen: {} })

/** 读「聊天对象 ↔ DSH session」映射 + 去重指纹 */
export function loadSessionMap() {
  ensureDir()
  try {
    if (!existsSync(paths.sessions)) return emptyMap()
    const raw = JSON.parse(readFileSync(paths.sessions, 'utf8'))
    return {
      version: 1,
      peers: raw?.peers && typeof raw.peers === 'object' ? raw.peers : {},
      seen: raw?.seen && typeof raw.seen === 'object' ? raw.seen : {},
    }
  } catch { return emptyMap() }
}

/** 写映射 */
export function saveSessionMap(map) {
  ensureDir()
  const tmp = paths.sessions + '.tmp'
  writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8')
  renameSync(tmp, paths.sessions)
  return map
}

/** 记一条「见过」——每个好友保留最近 MAX_SEEN 条 */
const MAX_SEEN = 400
export function markSeen(map, peer, fingerprint) {
  const list = map.seen[peer] || (map.seen[peer] = [])
  if (!list.includes(fingerprint)) list.push(fingerprint)
  while (list.length > MAX_SEEN) list.shift()
  return map
}

export function hasSeen(map, peer, fingerprint) {
  const list = map.seen[peer]
  return Array.isArray(list) && list.includes(fingerprint)
}

/** 消息指纹：好友名 + 发送方向 + 正文前 80 字 + 序号无关（靠正文去重） */
export function fingerprint(peer, msg) {
  const base = `${peer}|${msg.fromMe ? 'me' : 'peer'}|${String(msg.text || '').slice(0, 80)}`
  return createHash('sha1').update(base).digest('hex').slice(0, 16)
}

/** 取（或登记）某个好友对应的 DSH session id */
export function peerSession(map, peer) {
  const rec = map.peers[peer]
  return rec && typeof rec.sessionId === 'string' ? rec.sessionId : ''
}

export function setPeerSession(map, peer, sessionId, extra = {}) {
  const prev = map.peers[peer] || {}
  map.peers[peer] = { ...prev, ...extra, sessionId, updatedAt: Date.now() }
  return map
}

export function forgetPeer(map, peer) {
  delete map.peers[peer]
  delete map.seen[peer]
  return map
}

/* ── 日志 ──────────────────────────────────────────────────────────── */

/** 追加一行日志（只留最近 500 行） */
export function appendLog(line) {
  ensureDir()
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
  try {
    const prev = existsSync(paths.log) ? readFileSync(paths.log, 'utf8') : ''
    const lines = prev.split('\n').filter(Boolean)
    lines.push(`${stamp} ${line}`)
    while (lines.length > 500) lines.shift()
    writeFileSync(paths.log, lines.join('\n') + '\n', 'utf8')
  } catch { /* 日志失败不该拖垮桥接 */ }
}

/** 读日志尾部 */
export function tailLog(n = 80) {
  try {
    if (!existsSync(paths.log)) return []
    const lines = readFileSync(paths.log, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-n)
  } catch { return [] }
}

export { existsSync, readdirSync }

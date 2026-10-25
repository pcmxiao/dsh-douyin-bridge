#!/usr/bin/env node
/**
 * tools/dsh-rpc.mjs —— 往 DSH 的 Web API 发一个 unary RPC
 * ============================================================================
 * 用途：桌面版 DSH 的 profile 由 Electron 应用独占管理，CLI 的
 * `dsh plugin --profile desktop add` 会被拒（"managed exclusively by the
 * Electron application"）。所以装插件/查状态只能走**应用自己的 API**。
 *
 * 用法：
 *     node tools/dsh-rpc.mjs <endpoint> '<json-args>'
 *     node tools/dsh-rpc.mjs pluginManager/installBundle '{"spec":"E:\\path\\to\\pkg","options":{}}'
 *
 * 鉴权：读 `$DSH_HOME/.credentials.yaml` 里的
 * `client-connection/browser-session` 签名密钥，**离线铸造**一个浏览器会话
 * Cookie（HMAC-SHA256），不走启动 token。
 *
 * ⚠️ 这只对**本机回环**的 DSH 有意义：签名密钥就在本机，远端 DSH 用的是另一份。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

/**
 * DSH Web 的地址。
 *
 * 🔴 端口**每次启动都可能变**（Electron 挑空闲端口），所以不能写死。
 *    优先级：
 *      ① `$DSH_URL` 环境变量
 *      ② 从 DSH 进程的**监听端口**反查（最可靠）
 *      ③ 常见端口探测
 */
const BASE_URL = await resolveBaseUrl()
const BROWSER_SESSION_KEY = 'client-connection/browser-session'

async function resolveBaseUrl() {
  if (process.env.DSH_URL) return process.env.DSH_URL.replace(/\/$/, '')

  // ① 找 DSH 进程持有的监听端口
  //    思路：先拿 DSH 主进程的 PID，再列出该 PID 的 LISTEN 端口。
  //    （命令行里没有 --port，只能这样反查。）
  try {
    const { execFileSync } = await import('node:child_process')
    // 用 cmd 调 powershell 并强制单行输出，避免格式化成表格
    const script = [
      "$pids = @(Get-CimInstance Win32_Process -Filter \"Name like '%DeepSeek%'\" | ForEach-Object { $_.ProcessId })",
      "$ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $pids -contains $_.OwningProcess } | ForEach-Object { $_.LocalPort } | Sort-Object -Unique)",
      "Write-Output ($ports -join ' ')",
    ].join('; ')
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 15000,
    })
    const ports = String(out).match(/\d{4,5}/g) || []
    for (const p of ports) {
      const url = `http://127.0.0.1:${p}`
      if (await reachable(url)) return url
    }
  } catch { /* 拿不到就往下走 */ }

  // ② 探测常见端口
  for (const port of [54257, 62942, 59295, 43120, 3080]) {
    const url = `http://127.0.0.1:${port}`
    if (await reachable(url)) return url
  }

  // ③ 都不行就退回默认值（报错时至少提示是哪个地址）
  return 'http://127.0.0.1:62942'
}

function reachable(base) {
  return new Promise((resolve) => {
    try {
      const u = new URL(base)
      const req = http.request({
        hostname: u.hostname, port: u.port || 80, path: '/', method: 'GET', timeout: 1500,
      }, (res) => { res.resume(); resolve(true) })
      req.on('error', () => resolve(false))
      req.on('timeout', () => { req.destroy(); resolve(false) })
      req.end()
    } catch { resolve(false) }
  })
}

const base64url = (buf) => Buffer.from(buf).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 读 .credentials.yaml 里那条 32 字节签名密钥（不引 yaml 依赖，手搓解析） */
function readSecret() {
  const file = path.join(resolveDshHome(), '.credentials.yaml')
  const text = fs.readFileSync(file, 'utf8')
  // 只取那条记录下面的 payload.secret
  const lines = text.split(/\r?\n/)
  let inRecord = false
  let inPayload = false
  for (const line of lines) {
    if (/^\s{0,4}client-connection\/browser-session:\s*$/.test(line)) { inRecord = true; continue }
    if (inRecord && /^\s{0,4}payload:\s*$/.test(line)) { inPayload = true; continue }
    if (inPayload) {
      const m = line.match(/^\s+secret:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*$/)
      if (m) {
        const decoded = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
        if (decoded.byteLength === 32) return decoded
      }
      if (/^\s{0,4}\S/.test(line)) break
    }
  }
  throw new Error('在 .credentials.yaml 里没找到 client-connection/browser-session 的密钥')
}

/** 铸造浏览器会话 Cookie */
function mintCookie(secret) {
  const authority = new URL(BASE_URL).host
  const issuedAt = Date.now()
  const expiresAt = issuedAt + 60 * 60 * 1000
  const body = base64url(Buffer.from(JSON.stringify({
    version: 1, authority, issuedAt, expiresAt,
  }), 'utf8'))
  const signature = base64url(createHmac('sha256', secret).update(body).digest())
  const name = 'dsh-auth-' + base64url(createHash('sha256').update(authority).digest())
  return `${name}=v1.${body}.${signature}`
}

export async function callUnary(endpoint, args = {}, { timeoutMs = 1800000 } = {}) {
  const cookie = mintCookie(readSecret())
  const rpcId = randomUUID()
  const message = {
    type: 'client-request',
    rpcId,
    method: endpoint,
    payload: { args },
  }
  const body = JSON.stringify(message)
  const url = new URL(`${BASE_URL}/api/${endpoint}`)

  // ⚠️ 不用 fetch：undici 的 headersTimeout 默认 300 秒，而插件安装要跑 pnpm，
  //    经常超过 5 分钟 ⇒ fetch 会先抛 HeadersTimeoutError。用 node:http 自己控。
  const res = await new Promise((resolve, reject) => {
    const req = http.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        cookie,
      },
    }, (r) => {
      const chunks = []
      r.on('data', (c) => chunks.push(c))
      r.on('end', () => resolve({
        status: r.statusCode,
        text: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`请求超时（${timeoutMs}ms）`)) })
    req.end(body)
  })

  let full
  try { full = JSON.parse(res.text) } catch { full = { raw: res.text } }
  return { status: res.status, body: full }
}

/** 带会话 Cookie 的普通 GET（给插件自己的 HTTP 接口用） */
export async function getJson(path, { timeoutMs = 60000 } = {}) {
  return plainRequest('GET', path, undefined, { timeoutMs })
}

/** 带会话 Cookie 的普通 POST（给插件自己的 HTTP 接口用） */
export async function postJson(path, body, { timeoutMs = 300000 } = {}) {
  return plainRequest('POST', path, body, { timeoutMs })
}

async function plainRequest(method, path, body, { timeoutMs = 60000 } = {}) {
  const cookie = mintCookie(readSecret())
  const url = new URL(path.startsWith('/') ? path : `/${path}`, BASE_URL)
  const payload = body === undefined ? undefined : JSON.stringify(body)
  const res = await new Promise((resolve, reject) => {
    const req = http.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        cookie,
        origin: BASE_URL,
        referer: `${BASE_URL}/`,
        ...(payload === undefined
          ? {}
          : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
      },
    }, (r) => {
      const chunks = []
      r.on('data', (c) => chunks.push(c))
      r.on('end', () => resolve({
        status: r.statusCode,
        text: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`请求超时（${timeoutMs}ms）`)) })
    req.end(payload)
  })
  let full
  try { full = JSON.parse(res.text) } catch { full = { raw: res.text } }
  return { status: res.status, body: full }
}

/* ── CLI ─────────────────────────────────────────────────────────── */

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const endpoint = process.argv[2]
  if (!endpoint) {
    console.error('用法：node tools/dsh-rpc.mjs <endpoint> \'<json-args>\'\n'
      + '      node tools/dsh-rpc.mjs GET /api/douyin-bridge/status')
    process.exit(2)
  }
  // GET / POST 模式（打插件自己的 HTTP 接口）
  if (endpoint.toUpperCase() === 'GET') {
    const { status, body } = await getJson(process.argv[3] || '/')
    console.log(`HTTP ${status}`)
    console.log(typeof body === 'string' ? body : JSON.stringify(body, null, 2))
    process.exit(status >= 400 ? 1 : 0)
  }
  // POST 模式：第 3 个参数是 URL，第 4 个是 JSON body（'@file' 也行）
  if (endpoint.toUpperCase() === 'POST') {
    const urlPath = process.argv[3] || '/'
    const rawBody = process.argv[4] ?? '{}'
    const text = rawBody.startsWith('@') ? fs.readFileSync(rawBody.slice(1), 'utf8') : rawBody
    const { status, body } = await postJson(urlPath, JSON.parse(text))
    console.log(`HTTP ${status}`)
    console.log(typeof body === 'string' ? body : JSON.stringify(body, null, 2))
    process.exit(status >= 400 ? 1 : 0)
  }
  const raw = process.argv[3] ?? '{}'
  // '@file' = 从文件读 JSON（Windows 下 PowerShell 会把引号吃掉，命令行传 JSON 不可靠）
  const text = raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw
  const args = JSON.parse(text)
  const { status, body } = await callUnary(endpoint, args)
  console.log(`HTTP ${status}`)
  console.log(JSON.stringify(body, null, 2))
  process.exit(status >= 400 ? 1 : 0)
}

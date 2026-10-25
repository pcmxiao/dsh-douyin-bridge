/**
 * tools/probe-vision.mjs —— 决定性测试：**模型到底看不看得见图**
 * ============================================================================
 * 做法：
 *   ① 画一张有字的图（MAGIC WORD / PURPLE 7391 / TESTED 2026-10-26）
 *   ② 注入桥接会话（不真的发到抖音）
 *   ③ 从**原始会话日志**里找模型有没有说出图里的字
 *
 * 🔴 为什么读原始日志而不是 /events（2026-10-26 踩坑）：
 *    插件的 /events 只回 `type`/`seq`/`content` 摘要，**不含 reasoning**。
 *    模型其实一眼就读出了图里的字，但都写在 reasoning 里，
 *    摘要里看不到 ⇒ 脚本误判「它看不到图」。
 *    所以这里直接读 session.v4.jsonl.zstd 的全部事件。
 *
 * 用法：
 *   node tools/probe-vision.mjs                      # 用 DSH 默认模型
 *   node tools/probe-vision.mjs --peer=名字
 *   node tools/probe-vision.mjs --provider=minimax-cn --model=MiniMax-M3.1-Flash
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { readSessionEvents } from '../lib/session-history.mjs'

const argv = process.argv.slice(2)
const arg = (k, dflt = '') => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : dflt
}
const PROVIDER = arg('provider')
const MODEL = arg('model')
const PEER = arg('peer', `__vision_${Date.now() % 100000}__`)
const PORT = process.env.DSH_PORT || '54257'
const BASE = `http://127.0.0.1:${PORT}`
const log = (m) => console.log(m)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SECRET_WORDS = /MAGIC|PURPLE|7391|TESTED/i

// ── ① 画一张有字的图 ─────────────────────────────────────────────
const PY = join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')
const imgPath = join(tmpdir(), 'dsh-douyin', 'vision-test.png')
execFileSync(PY, ['-c', `
from PIL import Image, ImageDraw
img = Image.new('RGB', (520, 300), (252, 252, 248))
d = ImageDraw.Draw(img)
d.rectangle([16, 16, 504, 284], outline=(190, 25, 25), width=6)
d.text((46, 84), "MAGIC WORD", fill=(15, 15, 15))
d.text((46, 134), "PURPLE 7391", fill=(15, 15, 15))
d.text((46, 184), "TESTED 2026-10-26", fill=(15, 15, 15))
img.save(r"${imgPath}")
`])
const b64 = readFileSync(imgPath).toString('base64')
log(`① 图：${imgPath}（里面有 MAGIC WORD / PURPLE 7391 / TESTED 2026-10-26）`)

// ── ② 切模型（可选）──────────────────────────────────────────────
if (PROVIDER) {
  const cfgRes = await fetch(`${BASE}/dsh-douyin-bridge/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: PROVIDER, model: MODEL }),
  })
  const cfgOut = await cfgRes.json()
  log(`② 切模型 → ${cfgOut.config?.provider} / ${cfgOut.config?.model}`)
} else {
  const st = await (await fetch(`${BASE}/dsh-douyin-bridge/status`)).json()
  log(`② 用 DSH 默认模型 → ${st.status?.agentModel?.provider} / ${st.status?.agentModel?.model}`)
}

// ── ③ 注入 ──────────────────────────────────────────────────────
const inj = await fetch(`${BASE}/dsh-douyin-bridge/inject`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ peer: PEER, text: '[图片 520×300]', image: b64, width: 520, height: 300 }),
})
const injOut = await inj.json()
const sid = injOut.sessionId
log(`③ 注入 → ok=${injOut.ok} session=${sid}`)
if (!injOut.ok) process.exit(1)

// ── ④ 等回复，读原始日志 ─────────────────────────────────────────
log('④ 等 AI 回复（读原始会话日志，含 reasoning）…')
let allText = ''
for (let i = 0; i < 40; i++) {
  await sleep(3000)
  let ev
  try { ev = readSessionEvents(sid) } catch { continue }
  const list = Array.isArray(ev) ? ev : (ev?.events || [])
  const texts = []
  for (const e of list) {
    const s = JSON.stringify(e)
    for (const m of s.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)) {
      texts.push(m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'))
    }
  }
  allText = texts.join('\n')
  if (SECRET_WORDS.test(allText)) break
}

const snippet = (() => {
  const i = allText.search(SECRET_WORDS)
  if (i < 0) return allText.slice(0, 1500)
  return allText.slice(Math.max(0, i - 500), i + 800)
})()

log('\n──── 相关输出 ────')
console.log(snippet)
log('\n──── 结论 ────')
if (SECRET_WORDS.test(allText)) {
  log('✔ 模型**确实看见**了图片（输出里出现了图里的字：MAGIC / PURPLE 7391 / TESTED）')
} else {
  log('✘ 没在图里找到那些字 —— 模型看不到这张图')
  log('   排查顺序：① cordis.patch.yml 里模型有没有 input: [text, image]')
  log('            ② /dsh-douyin-bridge/models 里 canSeeImage 是不是 true')
  log('            ③ /dsh-douyin-bridge/status 里 attachments 是不是 true')
}

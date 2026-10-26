/**
 * tools/probe-respawn.mjs —— 验证「浏览器不会反复重启」
 * ============================================================================
 * 复现 2026-10-26 那个 bug（用户报「反复重启浏览器」）：
 *
 *   窗口被关掉 → 进程退出 → ready=false → 下一轮轮询又 spawn 一个
 *   ⇒ 浏览器每隔 20 秒自己弹一次，用户关都关不掉。
 *
 * 现场证据在 `bridge.log`：
 *   15:45:06 浏览器就绪    15:45:20 浏览器退出（code=0）
 *   15:45:23 浏览器就绪    15:45:50 浏览器退出（code=0）
 *   …循环 6 分钟…
 *
 * 这个脚本用**临时 profile + 独立端口**跑一遍完整链路：
 *   ① 首次 ensureBrowser → 起 1 个浏览器
 *   ② 并发调 5 次 ensureBrowser → 还是 1 个（不能弹 5 个窗口）
 *   ③ 用 CDP Browser.close 模拟「用户把窗口关了」→ 进程干净退出（code=0）
 *   ④ 再调 ensureBrowser → **必须报错、必须不再起浏览器**（这是修复的核心）
 *   ⑤ 显式 relaunch → 才重新起 1 个
 *
 * 用法：node tools/probe-respawn.mjs
 */
import { DouyinBridge } from '../lib/bridge.mjs'
import { browserProcesses, killTree } from '../lib/browser.mjs'
import { loadConfig } from '../lib/state.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// --real = 用真实的端口和 profile（会真的弹出浏览器窗口，但只是 about:blank）
const REAL = process.argv.includes('--real')
const cfgReal = REAL ? loadConfig() : null
const PORT = REAL ? Number(cfgReal.browserPort) : 47991
const PROFILE = REAL ? cfgReal.userDataDir : mkdtempSync(join(tmpdir(), 'dy-respawn-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 这个脚本不接宿主，只要一个「什么都读不到」的假 ctx */
const fakeCtx = { get: () => undefined, on: () => () => {} }

const bridge = new DouyinBridge({ ctx: fakeCtx, log: (m) => console.log('   [bridge]', m) })
bridge.cfg = {
  ...bridge.cfg,
  browserPort: PORT,
  userDataDir: PROFILE,
  peers: ['__probe__'],
  mode: 'off',
}

const count = async () => (await browserProcesses(PROFILE, PORT)).length
let failed = 0
const check = (name, got, want) => {
  const ok = got === want
  if (!ok) failed++
  console.log(`   ${ok ? '✅' : '❌'} ${name}：${got}（期望 ${want}）`)
}

/** 等到条件成立或超时 */
async function waitFor(fn, ms = 20000, step = 300) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn()) return true
    await sleep(step)
  }
  return false
}

console.log('① 第一次 ensureBrowser')
const b1 = await bridge.ensureBrowser()
await sleep(1500)
check('浏览器进程数', await count(), 1)
console.log('   同一个对象？', b1 === bridge.browser)

console.log('② 并发调 5 次 ensureBrowser')
const many = await Promise.all([
  bridge.ensureBrowser(), bridge.ensureBrowser(), bridge.ensureBrowser(),
  bridge.ensureBrowser(), bridge.ensureBrowser(),
])
await sleep(800)
check('浏览器进程数', await count(), 1)
check('拿到的都是同一个对象', new Set(many).size, 1)

console.log('③ 模拟用户关掉窗口（CDP Browser.close ⇒ 进程干净退出 code=0）')
try { await b1.send('Browser.close') } catch { /* 关了就断连接了，正常 */ }
const gone = await waitFor(async () => (await count()) === 0)
check('浏览器进程数', await count(), 0)
check('进程确实退出了', gone ? 1 : 0, 1)
// 等桥收到退出事件（异步的）
await waitFor(async () => bridge.browserClosed === true, 8000)
console.log('   bridge.browserClosed =', bridge.browserClosed, '（期望 true）')

console.log('④ 关掉之后再调 ensureBrowser —— 必须报错，且**不能再起浏览器**')
let threw = ''
try {
  await bridge.ensureBrowser()
} catch (e) {
  threw = String(e?.message || e)
}
console.log('   报错：', threw.split('\n')[0] || '（没报错！）')
check('确实报错了', threw ? 1 : 0, 1)
await sleep(2500)
check('浏览器进程数（关键：不能自己弹回来）', await count(), 0)

console.log('⑤ 显式 relaunch —— 这时候才允许重新起')
await bridge.ensureBrowser({ relaunch: true })
await sleep(1500)
check('浏览器进程数', await count(), 1)

console.log('⑥ 收工：清掉测试浏览器')
for (const pid of await browserProcesses(PROFILE, PORT)) await killTree(pid)
await sleep(1500)
check('浏览器进程数', await count(), 0)

try { if (!REAL) rmSync(PROFILE, { recursive: true, force: true }) } catch { /* 忽略 */ }

console.log(failed ? `\n❌ 有 ${failed} 项没过` : '\n✅ 全部通过：浏览器不会再反复重启')
process.exit(failed ? 1 : 0)

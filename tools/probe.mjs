/**
 * 诊断脚本：直接问浏览器「登录了没、会话列表读得到吗」。
 *
 * 桥接的轮询只在后台默默跑，出问题（没登录 / 面板没打开 / 选择器变了）
 * 只会体现在 `peers: 0` 上，看不出原因。这个脚本把中间状态全打出来。
 *
 * 跑之前先停掉桥接（设置页点「停止」，或 POST /dsh-douyin-bridge/stop），
 * 否则两边会抢同一个页面。
 *
 * 用法：node tools/probe.mjs
 */
import { getBrowser } from '../lib/browser.mjs'
import { checkLogin, dmList, currentPeer } from '../lib/douyin.mjs'
import { loadConfig } from '../lib/state.mjs'

const cfg = loadConfig()
const log = (m) => console.log(m)

console.log('── 浏览器')
const b = await getBrowser({ reuse: true, port: cfg.browserPort, log })
console.log('   连上了')

console.log('\n── 登录')
const st = await checkLogin(b)
console.log('   ', JSON.stringify(st))
if (!st.loggedIn) {
  console.log('   ✘ 没登录：打开抖音扫码，登录后再跑一次')
  process.exit(1)
}

console.log('\n── 会话列表')
const r = await dmList({ browser: b })
console.log('   ok:', r.ok, ' error:', r.error ?? '（无）')
const list = r.conversations ?? []
console.log('   会话数:', list.length)
for (const c of list.slice(0, 15)) {
  console.log('    ·', JSON.stringify({ name: c.name, desc: String(c.desc ?? '').slice(0, 30), time: c.time }))
}

console.log('\n── 当前打开的会话')
try {
  const cur = await currentPeer({ browser: b })
  console.log('   ', JSON.stringify(cur))
} catch (e) {
  console.log('   读不到:', e?.message || e)
}

process.exit(0)

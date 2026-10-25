/**
 * 端到端诊断：进某个好友的聊天 → 读消息 → 试着发一条 → 读回来验证。
 *
 * 用法：
 *   node tools/probe-dm.mjs "好友名"           # 只读
 *   node tools/probe-dm.mjs "好友名" --send "测试"  # 读 + 发
 */
import { getBrowser } from '../lib/browser.mjs'
import { readDM, sendDM, checkLogin, dmList } from '../lib/douyin.mjs'
import { loadConfig } from '../lib/state.mjs'

const cfg = loadConfig()
const peer = process.argv[2]
const sendIdx = process.argv.indexOf('--send')
const text = sendIdx >= 0 ? process.argv[sendIdx + 1] : ''

if (!peer) { console.log('用法：node tools/probe-dm.mjs "<好友名>" [--send "<文本>"]'); process.exit(2) }

const b = await getBrowser({ reuse: true, port: cfg.browserPort, log: (m) => console.log('[b]', m) })
console.log('登录:', JSON.stringify(await checkLogin(b)))

console.log('\n── 会话列表')
const list = await dmList({ browser: b })
for (const c of list.conversations ?? []) console.log('  ·', c.name, '|', c.time)

console.log(`\n── 读 ${peer} 的私信`)
const r = await readDM({ browser: b, uname: peer, limit: 12 })
console.log('ok:', r.ok, 'error:', r.error ?? '', '| via:', r.via ?? 'dom')
if (!r.ok) process.exit(1)
console.log('消息数:', r.messages?.length ?? 0)
for (const m of (r.messages ?? []).slice(-12)) {
  console.log(`  ${m.fromMe ? '我' : '他'}${m.isShare ? '[分享]' : ''}${m.system ? '[系统]' : ''}: ${String(m.text ?? '').slice(0, 60).replace(/\n/g, ' ')}`)
}

if (text) {
  console.log(`\n── 发送：「${text}」`)
  const s = await sendDM({ browser: b, uname: peer, text })
  console.log('ok:', s.ok, 'error:', s.error ?? '')

  console.log('\n── 读回验证')
  await new Promise((res) => setTimeout(res, 2500))
  const back = await readDM({ browser: b, uname: peer, limit: 6 })
  const last = (back.messages ?? []).slice(-3)
  for (const m of last) console.log(`  ${m.fromMe ? '我' : '他'}: ${String(m.text ?? '').slice(0, 60)}`)
}

process.exit(0)

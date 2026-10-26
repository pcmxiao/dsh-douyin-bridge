/**
 * tools/probe-media-chain.mjs —— 端到端验证媒体链路（读 / 发表情 / 发图片）
 * ============================================================================
 * 一次跑完三件事，每步都打印实际结果：
 *   ① 读私信 —— 看图片、表情、语音有没有被正确识别成类型 + 描述
 *   ② 发表情 —— 发一个「比心」，验证气泡真的出现了
 *   ③ 发图片 —— 发一张本机图片，验证气泡真的出现了
 *
 * 用法：
 *   node tools/probe-media-chain.mjs               # 默认发给「<好友名>」
 *   node tools/probe-media-chain.mjs "好友名"
 *
 * ⚠️ 跑之前先停桥接（POST /dsh-douyin-bridge/stop），否则两边抢同一个页面。
 * ⚠️ 会**真的发消息**给对方。
 */
import { getBrowser } from '../lib/browser.mjs'
import { readDM, sendImage, sendEmoji } from '../lib/douyin.mjs'
import { loadConfig } from '../lib/state.mjs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const cfg = loadConfig()
const peer = process.argv[2] || ''
const log = (m) => console.log(m)

const b = await getBrowser({ reuse: true, port: cfg.browserPort, log })

log('── ① 读一遍（合并 接口路 + DOM 路）')
const r = await readDM({ browser: b, limit: 30, uname: peer })
if (!r.ok) { log('读失败：' + r.error); process.exit(1) }
log(`via=${r.via} total=${r.total} 取回=${r.messages.length}`)
for (const m of r.messages) {
  const media = m.media || {}
  log(`  [${m.fromMe ? '我' : '他'}] type=${m.type || 'text'} ${JSON.stringify(m.text).slice(0, 60)}`
    + (media.src ? ` src=${String(media.src).slice(0, 50)}` : '')
    + (media.data ? ` data=${media.data.length}B` : '')
    + (media.name ? ` name=${media.name}` : '')
    + (media.seconds ? ` sec=${media.seconds}` : '')
    + (media.width ? ` ${media.width}x${media.height}` : ''))
}

log('\n── ② 发一个表情（比心）')
const e = await sendEmoji({ browser: b, name: '比心', uname: peer })
log(JSON.stringify(e))

log('\n── ③ 再读一遍（应该能看到新表情）')
const r2 = await readDM({ browser: b, limit: 10, uname: peer })
if (r2.ok) {
  for (const m of r2.messages.slice(-4)) {
    log(`  [${m.fromMe ? '我' : '他'}] type=${m.type || 'text'} ${JSON.stringify(m.text).slice(0, 60)}`)
  }
}

log('\n── ④ 发一张图片')
const img = join(tmpdir(), 'dsh-douyin', 'test-image.jpg')
const s = await sendImage({ browser: b, file: img, uname: peer })
log(JSON.stringify(s))

log('\n── ⑤ 最后再读一遍')
const r3 = await readDM({ browser: b, limit: 10, uname: peer })
if (r3.ok) {
  for (const m of r3.messages.slice(-4)) {
    const media = m.media || {}
    log(`  [${m.fromMe ? '我' : '他'}] type=${m.type || 'text'} ${JSON.stringify(m.text).slice(0, 60)}`
      + (media.data ? ` data=${media.data.length}B ${media.width}x${media.height}` : '')
      + (media.src ? ` src=${String(media.src).slice(0, 40)}` : ''))
  }
}

process.exit(0)

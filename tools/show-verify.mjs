/**
 * tools/show-verify.mjs —— bring the Douyin verification dialog to the front
 * ============================================================================
 *   node tools/show-verify.mjs            # 截图 + 把窗口叫到前台
 *
 * The account is being asked for an SMS code before it may post a comment.
 * The dialog is already open in the Douyin page; this just puts it in front
 * of the user and shows where things are.
 */
import { getBrowser } from '../lib/browser.mjs'
import { loadConfig } from '../lib/state.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const cfg = loadConfig()
const log = (m) => console.log(m)
const b = await getBrowser({ reuse: true, port: cfg.browserPort, log })

// 窗口叫到前台 + 恢复成 normal（最小化时页面不渲染）
try {
  const { windowId } = await b.send('Browser.getWindowForTarget', { targetId: b.targetId })
  const r = await b.send('Browser.getWindowBounds', { windowId })
  log(`windowState: ${r?.bounds?.windowState}`)
  await b.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
  await b.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal', focused: true } })
  log('window brought to front')
} catch (e) { log(`window focus failed: ${e.message}`) }

const st = await b.eval(`(() => {
  const t = document.body ? document.body.innerText : ''
  const need = /接收短信验证码|获取验证码|请输入验证码|滑块验证/.test(t)
  const m = /(\\d{3}\\*{2,}\\d{2,})/.exec(t)
  const input = [...document.querySelectorAll('input')]
    .filter(i => i.offsetParent !== null)
    .map(i => { const r = i.getBoundingClientRect()
      return { type: i.type, ph: i.placeholder, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: Math.round(r.width) } })
  const btn = [...document.querySelectorAll('button, [role="button"], div, span')]
    .filter(el => ['获取验证码', '验证', '取消', '使用原设备扫码'].includes((el.innerText || '').trim()))
    .map(el => { const r = el.getBoundingClientRect()
      return { txt: (el.innerText || '').trim(), x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: Math.round(r.width), h: Math.round(r.height) } })
    .filter(b => b.w > 20 && b.h > 10)
  return { need, phone: m ? m[1] : '', input, btn, url: location.href }
})()`)
log(`\nverification dialog: ${JSON.stringify(st, null, 1)}`)

const shotDir = join(process.cwd(), 'shots')
mkdirSync(shotDir, { recursive: true })
try {
  const s = await b.send('Page.captureScreenshot', { format: 'png' }, b.sessionId)
  writeFileSync(join(shotDir, 'verify-dialog.png'), Buffer.from(s.data, 'base64'))
  log('shot -> shots/verify-dialog.png')
} catch (e) { log(`shot failed: ${e.message}`) }

process.exit(0)

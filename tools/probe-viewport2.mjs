/**
 * tools/probe-viewport2.mjs —— 实验二：窗口 normal 之后能不能撑到 1920
 * ============================================================================
 * probe-viewport.mjs 的续集。那次 setWindowBounds 没生效，很可能是因为
 * 窗口当时是 **minimized**（outerWidth 报 0），resize 被系统忽略了。
 * 现在把它置为 normal 再试。
 *
 * 顺带试几个新招：
 *   · 清掉 Emulation override，让视口回到真实宽度
 *   · left 放到负数 —— 窗口伸出屏幕左边，Windows 才允许它比屏幕宽
 *   · setDeviceMetricsOverride + reload（重排）
 *
 * 用法：node tools/probe-viewport2.mjs
 */
import { getBrowser } from '../lib/browser.mjs'
import { loadConfig } from '../lib/state.mjs'

const cfg = loadConfig()
const log = (m) => console.log(m)
const b = await getBrowser({ reuse: true, port: cfg.browserPort, log })

const measure = () => b.eval(`(() => {
  const conv = document.querySelector('[data-e2e="conversation-item"]')
  const dlg  = document.querySelector('[data-e2e="im-dialog"]')
  const cr = conv?.getBoundingClientRect()
  const dr = dlg?.getBoundingClientRect()
  return {
    vw: innerWidth, vh: innerHeight, outer: [outerWidth, outerHeight],
    conv: cr ? [Math.round(cr.width), Math.round(cr.height)] : null,
    dlg: dr ? [Math.round(dr.width), Math.round(dr.height)] : null,
    msgInput: !!document.querySelector('[data-e2e="msg-input"]'),
  }
})()`)

const bounds = async () => {
  const { windowId } = await b.send('Browser.getWindowForTarget', { targetId: b.targetId })
  const r = await b.send('Browser.getWindowBounds', { windowId })
  return { windowId, ...r.bounds }
}

log('── 初始'); log('  ' + JSON.stringify(await measure())); log('  ' + JSON.stringify(await bounds()))

// ── 1. 清掉 Emulation override ──────────────────────────────────
log('\n── 1. clearDeviceMetricsOverride')
try { await b.send('Emulation.clearDeviceMetricsOverride', {}, b.sessionId); log('  ✔') } catch (e) { log(`  ✘ ${e.message}`) }
await new Promise(r => setTimeout(r, 2000))
log('  ' + JSON.stringify(await measure()))

// ── 2. 窗口置 normal，然后撑大（往屏幕左边伸）──────────────────
log('\n── 2. setWindowBounds 1920×1040 @ left=-2000')
try {
  const { windowId } = await b.send('Browser.getWindowForTarget', { targetId: b.targetId })
  await b.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
  await new Promise(r => setTimeout(r, 800))
  await b.send('Browser.setWindowBounds', {
    windowId,
    bounds: { left: -2000, top: 0, width: 1920, height: 1040, windowState: 'normal' },
  })
  await new Promise(r => setTimeout(r, 2500))
  log('  ' + JSON.stringify(await bounds()))
} catch (e) { log(`  ✘ ${e.message}`) }
log('  ' + JSON.stringify(await measure()))

// ── 3. 再撑一次（有时要两步才生效）────────────────────────────
log('\n── 3. 再来一次 setWindowBounds（换 left）')
try {
  const { windowId } = await b.send('Browser.getWindowForTarget', { targetId: b.targetId })
  await b.send('Browser.setWindowBounds', {
    windowId,
    bounds: { left: -1800, top: 0, width: 1920, height: 1040, windowState: 'normal' },
  })
  await new Promise(r => setTimeout(r, 2500))
  log('  ' + JSON.stringify(await bounds()))
} catch (e) { log(`  ✘ ${e.message}`) }
log('  ' + JSON.stringify(await measure()))

// ── 4. 重新打开私信面板，看会不会重新布局 ──────────────────────
log('\n── 4. 点 im-entry 重新打开面板')
await b.eval(`(() => {
  const el = document.querySelector('[data-e2e="im-entry"]')
  if (!el) return 'no-entry'
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  el.click()
  return 'clicked'
})()`).then(r => log('  ' + r)).catch(e => log('  ✘ ' + e.message))
await new Promise(r => setTimeout(r, 3000))
log('  ' + JSON.stringify(await measure()))

process.exit(0)

/**
 * tools/probe-viewport.mjs —— 实验：怎么让抖音的私信面板渲染出真实尺寸
 * ============================================================================
 * 背景：这台机器屏幕 CSS 宽度只有 1536，视口 1378，抖音把 im-dialog /
 *       conversation-item 渲染成 0×0 —— 面板等于没开（见 PITFALLS #23）。
 *
 * 试三种办法，看哪种能让会话项拿到非 0 尺寸：
 *   A. Emulation.setDeviceMetricsOverride（带 sessionId）
 *   B. A 之后强制重排（resize 事件 / reload）
 *   C. Browser.setWindowBounds 撑真实窗口
 *
 * 用法：node tools/probe-viewport.mjs
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
    vw: innerWidth, vh: innerHeight,
    sw: screen.availWidth, sh: screen.availHeight,
    outer: [outerWidth, outerHeight],
    conv: cr ? [Math.round(cr.width), Math.round(cr.height)] : null,
    dlg: dr ? [Math.round(dr.width), Math.round(dr.height)] : null,
    msgInput: !!document.querySelector('[data-e2e="msg-input"]'),
  }
})()`)

log('── 初始状态'); log(JSON.stringify(await measure()))

// ── A. Emulation.setDeviceMetricsOverride（带 sessionId）─────────
log('\n── A. Emulation.setDeviceMetricsOverride(1920×1040, 带 sessionId)')
try {
  await b.send('Emulation.setDeviceMetricsOverride', {
    width: 1920, height: 1040, deviceScaleFactor: 1, mobile: false,
  }, b.sessionId)
  log('  已发送')
} catch (e) { log(`  ✘ ${e.message}`) }
await new Promise(r => setTimeout(r, 2500))
log('  ' + JSON.stringify(await measure()))

// ── B. 强制重排 ─────────────────────────────────────────────────
log('\n── B.1 派发 resize 事件')
await b.eval(`(() => { window.dispatchEvent(new Event('resize')); return true })()`).catch(() => {})
await new Promise(r => setTimeout(r, 2000))
log('  ' + JSON.stringify(await measure()))

log('\n── B.2 改 zoom（CSS zoom 0.7，让布局视口等效变宽）')
await b.eval(`(() => { document.documentElement.style.zoom = '0.7'; return true })()`).catch(() => {})
await new Promise(r => setTimeout(r, 2000))
log('  ' + JSON.stringify(await measure()))

log('\n── B.3 撤掉 zoom')
await b.eval(`(() => { document.documentElement.style.zoom = ''; return true })()`).catch(() => {})
await new Promise(r => setTimeout(r, 1500))

// ── C. 真实窗口 ────────────────────────────────────────────────
log('\n── C. Browser.setWindowBounds(1920×1040)')
try {
  const { windowId } = await b.send('Browser.getWindowForTarget', { targetId: b.targetId })
  const before = await b.send('Browser.getWindowBounds', { windowId })
  log(`  之前: ${JSON.stringify(before.bounds)}`)
  await b.send('Browser.setWindowBounds', {
    windowId,
    bounds: { left: -2400, top: 0, width: 1920, height: 1040 },
  })
  await new Promise(r => setTimeout(r, 2500))
  const after = await b.send('Browser.getWindowBounds', { windowId })
  log(`  之后: ${JSON.stringify(after.bounds)}`)
} catch (e) { log(`  ✘ ${e.message}`) }
log('  ' + JSON.stringify(await measure()))

process.exit(0)

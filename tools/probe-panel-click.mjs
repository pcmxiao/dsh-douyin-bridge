/**
 * tools/probe-panel-click.mjs —— 找出「怎么才能打开私信面板」
 * ============================================================================
 * 背景：im-dialog 的祖先有 display:none —— 面板只是**关着**，不是屏幕太窄。
 *       但各种点法都没打开。逐个试，看哪个有效。
 *
 * 判定：面板打开 = 祖先不再是 display:none，且 im-dialog 有真实尺寸。
 *
 * 用法：node tools/probe-panel-click.mjs
 */
import { getBrowser } from '../lib/browser.mjs'
import { loadConfig } from '../lib/state.mjs'

const cfg = loadConfig()
const log = (m) => console.log(m)
const b = await getBrowser({ reuse: true, port: cfg.browserPort, log })

const MEASURE = `(() => {
  const el = document.querySelector('[data-e2e="im-dialog"]')
  if (!el) return { missing: true }
  const r = el.getBoundingClientRect()
  // 往上找第一个 display:none 的祖先
  let hiddenBy = null
  let n = el
  for (let i = 0; i < 8 && n; i++) {
    if (getComputedStyle(n).display === 'none') { hiddenBy = String(n.className||'').slice(0,50); break }
    n = n.parentElement
  }
  return { rect: [Math.round(r.width), Math.round(r.height)], hiddenBy, open: !hiddenBy && r.width > 100 }
})()`

const measure = async () => b.eval(MEASURE)

// ── 0. 摸清入口元素 ───────────────────────────────────────────
const entries = await b.eval(`(() => {
  const out = []
  for (const el of document.querySelectorAll('[data-e2e="im-entry"], [data-e2e="something-button"]')) {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    // 找它中心点最顶层的元素（真正会收到点击的那个）
    const cx = Math.round(r.left + r.width/2), cy = Math.round(r.top + r.height/2)
    const top = document.elementFromPoint(cx, cy)
    out.push({
      e2e: el.getAttribute('data-e2e'),
      cls: String(el.className||'').slice(0,50),
      rect: [Math.round(r.width), Math.round(r.height), Math.round(r.left), Math.round(r.top)],
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity, pointerEvents: cs.pointerEvents,
      zIndex: cs.zIndex,
      txt: (el.innerText||'').trim().slice(0,10),
      topAt: top ? { tag: top.tagName.toLowerCase(), cls: String(top.className?.baseVal ?? top.className ?? '').slice(0,50),
                     e2e: top.getAttribute('data-e2e')||'', txt: (top.innerText||'').trim().slice(0,10) } : null,
    })
  }
  return out
})()`)
log('── 入口元素')
for (const e of entries || []) {
  log(`  e2e=${e.e2e} ${e.rect.join('×')} display=${e.display} pe=${e.pointerEvents} z=${e.zIndex} txt=${e.txt}`)
  log(`     cls=${e.cls}`)
  log(`     中心点最顶层: <${e.topAt?.tag}> e2e=${e.topAt?.e2e} cls=${e.topAt?.cls} txt=${e.topAt?.txt}`)
}

const STRATEGIES = [
  ['真实鼠标点 im-entry 中心', async () => {
    const p = await b.eval(`(() => { const e=document.querySelector('[data-e2e="im-entry"]'); if(!e) return null; const r=e.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)} })()`)
    if (!p) return 'no-entry'
    for (const type of ['mousePressed', 'mouseReleased']) {
      await b.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 }, b.sessionId)
    }
    return `clicked @${p.x},${p.y}`
  }],
  ['真实鼠标点 elementFromPoint 拿到的元素', async () => {
    const p = await b.eval(`(() => {
      const e = document.querySelector('[data-e2e="im-entry"]'); if (!e) return null
      const r = e.getBoundingClientRect()
      const x = Math.round(r.left+r.width/2), y = Math.round(r.top+r.height/2)
      const t = document.elementFromPoint(x, y)
      const tr = t.getBoundingClientRect()
      return { x: Math.round(tr.left+tr.width/2), y: Math.round(tr.top+tr.height/2), tag: t.tagName.toLowerCase() }
    })()`)
    if (!p) return 'no-entry'
    for (const type of ['mousePressed', 'mouseReleased']) {
      await b.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 }, b.sessionId)
    }
    return `clicked <${p.tag}> @${p.x},${p.y}`
  }],
  ['JS .click() on im-entry', async () => {
    return b.eval(`(() => { const e=document.querySelector('[data-e2e="im-entry"]'); if(!e) return 'no'; e.click(); return 'clicked' })()`)
  }],
  ['JS 派发完整 mouse 序列 on im-entry', async () => {
    return b.eval(`(() => {
      const e=document.querySelector('[data-e2e="im-entry"]'); if(!e) return 'no'
      const o={bubbles:true,cancelable:true,view:window,clientX:0,clientY:0}
      e.dispatchEvent(new MouseEvent('pointerdown',o)); e.dispatchEvent(new MouseEvent('mousedown',o))
      e.dispatchEvent(new MouseEvent('pointerup',o)); e.dispatchEvent(new MouseEvent('mouseup',o))
      e.dispatchEvent(new MouseEvent('click',o)); return 'dispatched'
    })()`)
  }],
  ['JS 点文字「消息」叶子节点', async () => {
    return b.eval(`(() => {
      const el=[...document.querySelectorAll('*')].find(x=>(x.innerText||'').trim()==='消息'&&x.children.length===0&&x.getBoundingClientRect().width>0)
      if(!el) return 'no'
      const o={bubbles:true,cancelable:true,view:window}
      el.dispatchEvent(new MouseEvent('mousedown',o)); el.dispatchEvent(new MouseEvent('mouseup',o)); el.click()
      return 'clicked text'
    })()`)
  }],
  ['真实鼠标点文字「消息」叶子', async () => {
    const p = await b.eval(`(() => {
      const el=[...document.querySelectorAll('*')].find(x=>(x.innerText||'').trim()==='消息'&&x.children.length===0&&x.getBoundingClientRect().width>0)
      if(!el) return null; const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}
    })()`)
    if (!p) return 'no-text'
    for (const type of ['mousePressed', 'mouseReleased']) {
      await b.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 }, b.sessionId)
    }
    return `clicked text @${p.x},${p.y}`
  }],
]

for (const [name, fn] of STRATEGIES) {
  const before = await measure()
  let r
  try { r = await fn() } catch (e) { r = 'ERR ' + e.message }
  await new Promise(res => setTimeout(res, 2200))
  const after = await measure()
  log(`\n【${name}】 ${r}`)
  log(`   前: ${JSON.stringify(before)}`)
  log(`   后: ${JSON.stringify(after)}  ${after?.open ? '  ✅ 打开了' : '  ❌ 没开'}`)
  if (after?.open) { log('\n🎉 有效策略：' + name); break }
  // 没开就关掉重置（避免 toggle 状态乱）
  await b.eval(`(() => {
    const e=document.querySelector('[data-e2e="im-dialog"]')
    let n=e, hid=null
    for(let i=0;i<8&&n;i++){ if(getComputedStyle(n).display==='none'){hid=n;break} n=n.parentElement }
    return hid? 'still-closed':'open-but-small'
  })()`)
}

process.exit(0)

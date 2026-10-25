/** 实测选择器自检：能不能正确判断哪条降级链在生效 */
import { getBrowser } from '../lib/browser.mjs'
import { checkLogin, ensurePanel } from '../lib/douyin.mjs'
import { canary, whichHits, SEL } from '../lib/selectors.mjs'
import { loadConfig } from '../lib/state.mjs'

const cfg = loadConfig()
const b = await getBrowser({ reuse: true, port: cfg.browserPort, log: (m) => console.log('[b]', m) })
console.log('登录:', JSON.stringify(await checkLogin(b)))

const st = await ensurePanel(b)
console.log('面板:', JSON.stringify({ open: st.panelOpen, n: st.convCount }))
await new Promise((r) => setTimeout(r, 2000))

console.log('\n=== 逐条看哪个选择器命中 ===')
for (const key of Object.keys(SEL)) {
  const r = await whichHits(b, SEL[key])
  const mark = r.count > 0 ? '✔' : '·'
  console.log(`  ${mark} ${key.padEnd(20)} ${String(r.count).padStart(3)} 个  ${r.selector || '(全挂)'}`)
}

console.log('\n=== canary 结论 ===')
const c = await canary(b)
console.log(JSON.stringify(c, null, 2))

process.exit(0)

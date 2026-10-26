/**
 * tools/test-share-comment.mjs —— exercise the share-a-comment flow
 * ============================================================================
 *   1. open a video
 *   2. list its comments
 *   3. click the first comment's 分享
 *   4. dump the 分享给朋友 row (friend chips)
 *   5. optionally actually share to a friend (--to <name>)
 *
 * Usage: node tools/test-share-comment.mjs [videoId] [--to <name>]
 */
import { getBrowser } from '../lib/browser.mjs'
import { loadConfig } from '../lib/state.mjs'
import { openVideoPage, listComments, openSharePanel, listShareTargets, shareComment, detectVerification } from '../lib/comment.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const cfg = loadConfig()
const log = (m) => console.log(m)
const b = await getBrowser({ reuse: true, port: cfg.browserPort, log })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const shotDir = join(process.cwd(), 'shots')
mkdirSync(shotDir, { recursive: true })
const shot = async (name) => {
  try {
    const r = await b.send('Page.captureScreenshot', { format: 'png' }, b.sessionId)
    writeFileSync(join(shotDir, `${name}.png`), Buffer.from(r.data, 'base64'))
    log(`  shot -> ${name}.png`)
  } catch (e) { log(`  shot failed: ${e.message}`) }
}

const args = process.argv.slice(2)
const vid = args.find(a => /^\d{15,}$/.test(a)) || '7697459346984897955'
const toIdx = args.indexOf('--to')
const to = toIdx >= 0 ? args[toIdx + 1] : ''

const page = await openVideoPage({ browser: b, ids: [vid], prefer: 'video' })
log(`openVideoPage: ${page.ok ? page.id : page.error} layout=${page.layout} url=${page.state?.url}`)
if (!page.ok) process.exit(1)

const list = await listComments(b)
log(`\ncomments: ${list.length}`)
for (const c of list.slice(0, 5)) {
  log(`  [${c.i}] ${c.author} | share=${c.hasShare} | ${c.text.slice(0, 60)}`)
}

const opened = await openSharePanel(b, 0)
log(`\nopenSharePanel: ${JSON.stringify(opened)}`)
await sleep(1500)
await shot('sc-1-share-row')

const targets = await listShareTargets(b)
log(`\n分享给朋友 targets (${targets.length}):`)
for (const t of targets) log(`  "${t.name}"  txt="${t.txt}"  hasShare=${t.hasShare}  ${t.w}x${t.h}`)

if (to) {
  const r = await shareComment({ browser: b, id: vid, to, index: 0 })
  log(`\nshareComment(to=${to}): ${JSON.stringify(r)}`)
  await shot('sc-2-shared')
  const v = await detectVerification(b)
  log(`verification: ${JSON.stringify(v)}`)
}

process.exit(0)

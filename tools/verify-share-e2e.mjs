/**
 * tools/verify-share-e2e.mjs —— end-to-end proof for 分享评论
 * ============================================================================
 *   before: count the peer's DM bubbles
 *   share : share a comment to the peer
 *   after : count again -- a new bubble = the card arrived
 *
 * Usage: node tools/verify-share-e2e.mjs <peerName> [videoId]
 */
import { getBrowser } from '../lib/browser.mjs'
import { loadConfig } from '../lib/state.mjs'
import { readDM } from '../lib/douyin.mjs'
import { shareComment, detectVerification } from '../lib/comment.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const cfg = loadConfig()
const log = (m) => console.log(m)
const b = await getBrowser({ reuse: true, port: cfg.browserPort, log })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const peer = process.argv[2] || ''
const vid = process.argv[3] || '7697459346984897955'
if (!peer) { log('need a peer name'); process.exit(1) }

const shotDir = join(process.cwd(), 'shots')
mkdirSync(shotDir, { recursive: true })
const shot = async (n) => {
  try {
    const s = await b.send('Page.captureScreenshot', { format: 'png' }, b.sessionId)
    writeFileSync(join(shotDir, `${n}.png`), Buffer.from(s.data, 'base64'))
  } catch { /* ignore */ }
}

const snap = async (tag) => {
  const r = await readDM({ browser: b, uname: peer, limit: 20 })
  const ms = r?.messages || []
  log(`\n[${tag}] ${ms.length} bubbles`)
  ms.slice(0, 6).forEach((m, i) => {
    log(`  ${i}. fromMe=${m.fromMe} type=${m.type} isShare=${m.isShare} txt=${String(m.text || '').slice(0, 50)}`)
  })
  return ms
}

const before = await snap('before')

log(`\nsharing a comment to ${peer} …`)
const r = await shareComment({ browser: b, id: vid, to: peer, index: 0 })
log(`shareComment: ${JSON.stringify(r)}`)
await sleep(6000)
await shot('vse-1-after-share')

const after = await snap('after')
const v = await detectVerification(b)
log(`\nverification: ${JSON.stringify(v)}`)

const grew = after.length > before.length
log(`\nnew bubbles: ${after.length - before.length} -> ${grew ? 'CARD ARRIVED' : 'NO NEW BUBBLE'}`)

process.exit(0)

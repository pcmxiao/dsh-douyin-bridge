/**
 * tools/test-comment.mjs —— exercise the comment flows end to end
 * ============================================================================
 *   1. open a video page
 *   2. list its comments
 *   3. type into the comment box (dry run, no publish)
 *   4. find the publish button
 *   5. open the "share this comment" panel and dump its structure
 *
 * Usage: node tools/test-comment.mjs [keyword]
 */
import { getBrowser } from '../lib/browser.mjs'
import { search } from '../lib/douyin.mjs'
import { loadConfig } from '../lib/state.mjs'
import { openVideoPage, typeComment, clickPublish, listComments, openSharePanel, postComment } from '../lib/comment.mjs'

const cfg = loadConfig()
const log = (m) => console.log(m)
const b = await getBrowser({ reuse: true, port: cfg.browserPort, log })

const kw = process.argv[2] || 'cat'
const ids = (await search({ browser: b, keyword: kw, limit: 6 })).map(v => v.id).filter(Boolean)
log(`candidates: ${ids.join(', ')}`)

const snap = async (tag) => {
  const s = await b.eval(`(() => {
    const box = document.querySelector('.comment-input-inner-container')
    const items = [...document.querySelectorAll('[data-e2e="comment-item"]')]
    const r = box ? box.getBoundingClientRect() : null
    return {
      url: location.href,
      box: !!box,
      boxW: r ? Math.round(r.width) : 0,
      boxH: r ? Math.round(r.height) : 0,
      items: items.length,
      bodyLen: document.body ? document.body.innerText.length : 0,
      editable: !!document.querySelector('[contenteditable="true"]'),
    }
  })()`).catch(e => ({ err: e.message }))
  log(`  [${tag}] ${JSON.stringify(s)}`)
  return s
}

const page = await openVideoPage({ browser: b, ids })
log(`openVideoPage: ${JSON.stringify(page)}`)
if (!page.ok) process.exit(1)
await snap('after open')

const list = await listComments(b)
log(`\ncomments: ${list.length}`)
for (const c of list.slice(0, 6)) {
  log(`  [${c.i}] ${c.author} | share=${c.hasShare} | ${c.text.slice(0, 70)}`)
}
await snap('after list')

const typed = await typeComment(b, '测试评论内容')
log(`\ntypeComment: ${JSON.stringify(typed)}`)
await snap('after type')
if (typed.ok) {
  const pub = await clickPublish(b)
  log(`clickPublish: ${JSON.stringify(pub)}`)
  await snap('after publish')
}

const share = await openSharePanel(b, 0)
log(`\nopenSharePanel ok=${share.ok} ${share.error || ''}`)
for (const p of share.panel || []) {
  log(`  <${p.cls}> e2e=${p.e2e} ${p.pos} ${p.w}x${p.h} @${p.x},${p.y}`)
  log(`      ${p.txt}`)
}

// ── 真的发一条评论（会真的发出去）─────────────────────────────
if (process.argv.includes('--post')) {
  const vid = ids[0]
  const r = await postComment({ browser: b, id: vid, text: '自动测试评论，来自 dsh-douyin-bridge' })
  log(`\npostComment: ${JSON.stringify(r)}`)
}

process.exit(0)

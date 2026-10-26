/**
 * tools/probe-voice-bubble.mjs —— find the voice-bubble component in the web bundle
 * ============================================================================
 * The message-type enum has VOICE=17 / IM_ENCRYPT_VOICE=109, but the payload
 * shape is what we actually need. The web build must parse it to render the
 * bubble, so grep the bundles for the component and the fields it reads.
 *
 * Usage: node tools/probe-voice-bubble.mjs
 */
import { getBrowser } from '../lib/browser.mjs'
import { loadConfig } from '../lib/state.mjs'

const cfg = loadConfig()
const log = (m) => console.log(m)
const b = await getBrowser({ reuse: true, port: cfg.browserPort, log })

const scripts = await b.eval(`(() => {
  const urls = new Set()
  for (const s of document.querySelectorAll('script[src]')) urls.add(s.src)
  for (const e of performance.getEntriesByType('resource')) if (/\\.js(\\?|$)/.test(e.name)) urls.add(e.name)
  return [...urls]
})()`)

const texts = []
for (const url of scripts || []) {
  try {
    const r = await fetch(url, { headers: { referer: 'https://www.douyin.com/' } })
    if (!r.ok) continue
    texts.push({ url, t: Buffer.from(await r.arrayBuffer()).toString('utf8') })
  } catch { /* skip */ }
}
log(`downloaded ${texts.length} js files\n`)

const NEEDLES = [
  'MessageItemAudio',
  'IM_ENCRYPT_VOICE',
  'voiceDuration',
  'voice_duration',
  'voiceUri',
  'voice_uri',
  'voiceUrl',
  'voice_url',
  'voiceResourceId',
  'encryptVoice',
  'encrypt_voice',
  'voiceMsg',
  'voice_msg',
  'playVoice',
]

for (const needle of NEEDLES) {
  let found = 0
  for (const { url, t } of texts) {
    if (!t.includes(needle)) continue
    let idx = -1
    let hits = 0
    while (hits < 2) {
      idx = t.indexOf(needle, idx + 1)
      if (idx < 0) break
      hits++
      const snip = t.slice(Math.max(0, idx - 320), idx + 420).replace(/\s+/g, ' ')
      log(`\n### ${needle}  (${url.split('/').pop().slice(0, 46)} @${idx})`)
      log(snip)
    }
    found += hits
    if (found >= 2) break
  }
  if (!found) log(`  (no hit: ${needle})`)
}

process.exit(0)

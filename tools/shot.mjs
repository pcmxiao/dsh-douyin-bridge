/**
 * tools/shot.mjs —— 截一张图，用眼睛看抖音现在是什么状态
 * ============================================================================
 * 「工具返回 ok 但什么都没发生」时最有用：截图一眼就知道
 * 是面板没开、进错会话、还是页面根本在 about:blank。
 *
 * 用法：node tools/shot.mjs [输出路径]
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { getBrowser } from '../lib/browser.mjs'
import { loadConfig } from '../lib/state.mjs'

const cfg = loadConfig()
const b = await getBrowser({ reuse: true, port: cfg.browserPort, log: () => {} })
const out = process.argv[2] || join(tmpdir(), 'dsh-douyin', `shot-${Date.now()}.png`)

try { mkdirSync(dirname(out), { recursive: true }) } catch { /* 忽略 */ }

const r = await b.send('Page.captureScreenshot', { format: 'png' }, b.sessionId)
writeFileSync(out, Buffer.from(r.data, 'base64'))
console.log('已保存：', out)
process.exit(0)

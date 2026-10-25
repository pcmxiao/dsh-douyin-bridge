/**
 * 彻底重装插件：移除 → 再装。
 *
 * 为什么要这么做：DSH 的热重载会留下**旧实例**（旧代码还在内存里跑），
 * 反复 `reload` 只会越积越多，日志刷屏。移除重装能保证干净。
 *
 * 用法：node tools/reinstall.mjs
 */
import { callUnary } from './dsh-rpc.mjs'

const NAME = 'dsh-douyin-bridge'
const SPEC = 'E:\\deepseek harness-workspace\\dsh-douyin-bridge'

console.log('① 移除...')
const rm = await callUnary('pluginManager/removeBundle', { name: NAME })
console.log('   ', JSON.stringify(rm.body?.result?.value ?? rm.body?.result ?? rm.body).slice(0, 300))

await new Promise((r) => setTimeout(r, 2000))

console.log('② 安装...')
const add = await callUnary('pluginManager/installBundle', {
  spec: SPEC,
  options: { enabled: true, requestId: `reinstall-${Date.now()}` },
}, { timeoutMs: 1800000 })
const v = add.body?.result?.value
console.log('   application:', v?.application, ' version:', v?.version, ' changed:', v?.changed)
if (v?.error) console.log('   error:', JSON.stringify(v.error).slice(0, 400))

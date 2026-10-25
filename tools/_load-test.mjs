/**
 * 本地加载测试：用**模仿 cordis 代理行为**的假 ctx 跑一遍 apply()。
 *
 * 为什么需要它：DSH 的 cordis 给每个插件套了个 Proxy，**没在 inject 里声明过的服务，
 * 一读就抛** `cannot get property "X" without inject` —— 插件直接不激活，
 * 而桌面版的这条报错不进任何日志文件（只在 installBundle 的 diagnostic 里闪一次）。
 * 所以本地必须能复现这件事：
 *   · 只有 inject 声明过的服务名才允许读
 *   · ctx.get(name) 是安全读法，读不到返回 undefined
 *   · ctx.inject(deps, cb) 会把 cb 用一个「多了这些服务」的 scoped ctx 调一次
 *
 * 跑法：node tools/_load-test.mjs
 */
import { pathToFileURL, fileURLToPath } from 'node:url'

const mod = await import(pathToFileURL(fileURLToPath(new URL('../index.js', import.meta.url))).href)

const KNOWN_SERVICES = [
  'tools', 'agents', 'sessions', 'agentLoop', 'webServer', 'systemPrompt',
  'agentPresets', 'connection', 'hmr', 'loader', 'logger', 'reflect', 'events',
  'registry', 'effect', 'plugin', 'inject', 'get', 'on', 'emit', 'waterfall',
]

const registered = []
const injectedDeps = []
const effects = []
const logs = []
const injectCallbacks = []

function makeCtx(declared) {
  const base = {
    logger: {
      info: (...a) => logs.push(['info', ...a]),
      warn: (...a) => logs.push(['warn', ...a]),
      error: (...a) => logs.push(['error', ...a]),
      debug: (...a) => logs.push(['debug', ...a]),
    },
    tools: { register: (t) => { registered.push(t.name); return () => {} } },
    effect: (fn, label) => { effects.push(label); return () => {} },
    inject: (deps, cb) => {
      injectedDeps.push(deps)
      injectCallbacks.push({ deps, cb })
      return () => {}
    },
    get: (name) => (declared.includes(name) ? (base[name] ?? {}) : undefined),
    on: () => () => {},
    emit: () => {},
    waterfall: () => {},
    registry: { get: () => undefined },
    loader: { entries: () => [] },
    reflect: { get: (n) => undefined },
  }
  // 关键：模仿 cordis 的 Proxy 陷阱
  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop.startsWith('_')) return Reflect.get(target, prop)
      if (Reflect.has(target, prop)) return Reflect.get(target, prop)
      if (KNOWN_SERVICES.includes(prop) && !declared.includes(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      return undefined
    },
  })
}

const config = {
  enabled: true, browser: '', browserPort: 47881, userDataDir: '',
  pollIntervalMs: 20000, mode: 'simulation', peers: [], sharePeers: [],
  autoReply: true, maxInjectChars: 4000, cwd: '', personaFile: 'persona.md',
  agentPreset: '', provider: '', model: '', reasoningEffort: '',
}

let failed = 0

// ① 插件自己的 ctx：只声明了 tools
try {
  const ctx = makeCtx(['tools'])
  const dispose = await mod.apply(ctx, config)
  console.log('✔ apply() 成功')
  console.log('  注册的工具:', registered.length, registered.join(', '))
  console.log('  inject 的依赖:', JSON.stringify(injectedDeps))
  console.log('  effect:', JSON.stringify(effects))
  if (typeof dispose === 'function') dispose()
} catch (e) {
  failed++
  console.error('✘ apply() 失败:', e?.message)
  console.error(e?.stack)
}

// ② 真的把每个 inject 回调跑一遍，看它在 scoped ctx 上会不会炸
for (const { deps, cb } of injectCallbacks) {
  try {
    const scoped = makeCtx(['tools', ...deps])
    await cb(scoped)
    console.log(`✔ inject ${JSON.stringify(deps)} 回调执行通过`)
  } catch (e) {
    failed++
    console.error(`✘ inject ${JSON.stringify(deps)} 回调失败:`, e?.message)
    console.error(e?.stack?.split('\n').slice(0, 6).join('\n'))
  }
}

console.log('')
if (failed === 0) console.log('✔ 加载测试通过（0 项失败）')
else { console.log(`✘ 加载测试失败 ${failed} 项`); process.exit(1) }

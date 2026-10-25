/**
 * lib/hostdeps.mjs —— 从宿主那棵树里取 `@deepseek-ai/*`，取不到就退回等价实现
 * ============================================================================
 * 🔴 为什么必须这样（这是桌面版插件装不起来的经典坑）：
 *   插件的 `index.js` 如果**裸 import** `@deepseek-ai/dsh-tools`，而它在
 *   package.json 里是 **optional peer**，那么桌面版 profile
 *   （`autoInstallPeers: false`）**永远不会装它** ⇒ 整条插件不激活，
 *   DSH 只留一句 `warning: 1 entry did not activate … failed to import`。
 *
 *   ⇒ 策略（三条一起走）：
 *     ① **优先从宿主那棵树里解析**（跟宿主用同一份，行为最一致）；
 *     ② 解析不到就 **bare import**（靠我们自己 package.json 的 `dependencies` 保底）；
 *     ③ 彻底拿不到 ⇒ 用**本地等价实现**顶上，**绝不因为一个 import 就让插件不激活**。
 *
 * 技术手法与 `dsh-bili-scroll` 的 `lib/hostdeps.mjs` 同源（那是本仓库的参考实现，
 * MIT 许可，见 NOTICE.md）；这里是按本插件的需要重写的版本。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 插件自己那棵树（`dependencies` 装出来的那份）—— 用模块位置算，不依赖 cwd */
const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

/** 从某个起点往上找 `node_modules/@deepseek-ai` */
function walkUp(start, levels = 6) {
  const out = []
  let dir = start
  for (let i = 0; i < levels && dir; i++) {
    const p = join(dir, 'node_modules', '@deepseek-ai')
    if (!out.includes(p)) out.push(p)
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return out
}

/** 可能藏着宿主 `@deepseek-ai` 包的地方（不写死某一台机器，按可能性排序） */
export function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)
  push(process.env.DSH_APP_MODULES)

  // 🔴 桌面版：宿主包在 app 目录里，而 app 目录的路径只有从 exe 才能推出来
  try {
    const exeDir = dirname(process.execPath)
    push(join(exeDir, 'resources', 'app', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(exeDir, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(exeDir, 'resources', 'app', 'node_modules', '@deepseek-ai'))
    for (const p of walkUp(exeDir, 4)) push(p)
  } catch { /* 忽略 */ }

  // 当前工作目录往上（开发态跑在 DSH 仓库里时有用）
  try { for (const p of walkUp(process.cwd(), 5)) push(p) } catch { /* 忽略 */ }

  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    try {
      for (const n of readdirSync(join(npm, '@deepseek-ai'))) {
        push(join(npm, '@deepseek-ai', n, 'node_modules', '@deepseek-ai'))
      }
    } catch { /* 没有就算了 */ }
  }
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/local/lib/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai')

  // profile 树：这些包有时是被别的插件 hoist 到 profile 根上的
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
    }
  } catch { /* 没有就算了 */ }

  // 插件自己那份 —— 放最后，前面优先「跟宿主同一份」
  push(SELF_MODULES)
  return out
}

/** 按包的 exports['.'] 找入口文件，返回 file:// URL */
function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string'
      ? dot
      : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch { return null }
}

/** 试从宿主树里 import 一个包；拿不到返回 null */
async function fromHostTree(name, log) {
  const fails = []
  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue          // 自己那份交给下面的 bare import
    const url = entryUrlFor(root, name)
    if (!url) continue
    try {
      const mod = await import(url)
      log(`${name}：从宿主树取到`)
      return mod
    } catch (e) { fails.push(`${e?.code || 'ERR'}:${root}`) }
  }
  if (fails.length) log(`${name}：宿主树里都不行（${fails.slice(0, 3).join(' ')}）`)
  return null
}

/**
 * 兜底：这是**我们自己的等价实现**，只在拿不到宿主的 dsh-tools 时用。
 *
 * 宿主的 `defineTool` 做两件事：把 `parameters` 规格转成 JSON Schema、执行前校验参数。
 * 我们的 `parameters` / `output.schema` **本来就是标准 JSON Schema 写法**，
 * 所以这里只补一条同等的「object 必须写 additionalProperties」校验，其余原样返回。
 */
function localDefineTool(options, log) {
  const check = (schema, where) => {
    if (!schema || typeof schema !== 'object') return
    if (schema.type === 'object' && schema.additionalProperties === undefined) {
      throw new Error(`defineTool(${options.name}): ${where} 是 object 却没写 additionalProperties`)
    }
    for (const [k, v] of Object.entries(schema.properties || {})) check(v, `${where}.properties.${k}`)
  }
  check(options.parameters, 'parameters')
  check(options.output?.schema, 'output.schema')
  log?.(`dsh-tools 拿不到 —— 用本地等价实现顶上了（工具 ${options.name}）`)
  return options
}

/**
 * 取回宿主半晌要用的一点点东西。
 * @returns {Promise<{z:any, defineTool:Function, createUserMessage:Function, notes:string[]}>}
 */
export async function loadHostDeps() {
  const notes = []
  const log = (m) => notes.push(m)

  // ① schemastery（Config 要用）
  let zMod = await fromHostTree('schemastery', log)
  if (!zMod) {
    try { zMod = await import('@deepseek-ai/schemastery'); log('schemastery：宿主树里没有，用自己依赖里那份') }
    catch (e) { log(`⚠️ schemastery 彻底拿不到（${e?.code || ''}）—— 本插件没有 Config，设置页降级（插件本体照常跑）`) }
  }
  const z = zMod?.default ?? zMod ?? null

  // ② dsh-tools 的 defineTool（拿不到就用本地等价实现）
  let dtMod = await fromHostTree('dsh-tools', log)
  if (!dtMod) {
    try { dtMod = await import('@deepseek-ai/dsh-tools'); log('dsh-tools：宿主树里没有，用自己依赖里那份') }
    catch { log('dsh-tools 拿不到 —— 用本地等价实现顶上'); dtMod = null }
  }
  const defineTool = dtMod?.defineTool || ((options) => localDefineTool(options, log))

  // ③ dsh-llm 的 createUserMessage（构造注入进 DSH 会话的用户消息）
  let llmMod = await fromHostTree('dsh-llm', log)
  if (!llmMod) {
    try { llmMod = await import('@deepseek-ai/dsh-llm'); log('dsh-llm：宿主树里没有，用自己依赖里那份') }
    catch { log('dsh-llm 拿不到 —— 用本地等价实现顶上'); llmMod = null }
  }
  const createUserMessage = llmMod?.createUserMessage || localCreateUserMessage

  return { z, defineTool, createUserMessage, notes }
}

/**
 * 兜底：本地等价的 createUserMessage。
 *
 * 宿主的实现会冻结消息并盖一个稳定 id；这里做的事一样，
 * 差别只在 id 用随机 UUID 而不是品牌化字符串 —— 对「消息进 inbox」这条路径没影响。
 */
function localCreateUserMessage(input) {
  return {
    ...structuredClone(input),
    role: 'user',
    id: randomUUID(),
  }
}

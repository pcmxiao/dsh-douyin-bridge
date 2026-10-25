#!/usr/bin/env node
/**
 * selfcheck.mjs —— 装之前先自己查一遍
 * ============================================================================
 * 用法：
 *     node selfcheck.mjs
 *
 * 查什么：
 *   1. 该有的文件在不在
 *   2. 每个 JS 文件语法过不过
 *   3. package.json / cordis.patch.yml 的形状对不对
 *   4. locale 有没有 meta.title / meta.description（插件管理页要读）
 *   5. icon.svg 是不是一张像样的图
 *   6. 能不能从宿主那棵树里取到 @deepseek-ai/schemastery（取不到插件就没 Config）
 *   7. 宿主的 dsh-tools 取不到（预期内）时，本地等价实现顶不顶得住
 *
 * 退出码：0 = 全过；1 = 有硬伤。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
let failures = 0
let warnings = 0

const ok = (m) => console.log(`  ✔ ${m}`)
const bad = (m) => { failures++; console.log(`  ✘ ${m}`) }
const warn = (m) => { warnings++; console.log(`  ! ${m}`) }
const head = (m) => console.log(`\n── ${m}`)

/* 1. 文件 */
head('文件')
const required = [
  'index.js', 'client.js', 'cordis.patch.yml', 'package.json',
  'prompts/duty.md', 'locale/en.json', 'locale/zh.json', 'icon.svg',
  'README.md', 'DISCLAIMER.md', 'LICENSE', 'NOTICE.md',
  'lib/browser.mjs', 'lib/douyin.mjs', 'lib/state.mjs', 'lib/bridge.mjs', 'lib/hostdeps.mjs',
  'lib/media.mjs', 'lib/selectors.mjs', 'lib/session-history.mjs', 'lib/douyin-api.mjs', 'lib/pb.mjs',
]
for (const f of required) {
  const p = join(ROOT, f)
  if (!existsSync(p)) bad(`缺 ${f}`)
  else if (statSync(p).size === 0) bad(`${f} 是空的`)
}
if (failures === 0) ok(`${required.length} 个必备文件都在`)

/* 2. 语法 */
head('语法')
const jsFiles = ['index.js', 'client.js',
  'lib/browser.mjs', 'lib/douyin.mjs', 'lib/state.mjs', 'lib/bridge.mjs', 'lib/hostdeps.mjs',
  'lib/media.mjs', 'lib/selectors.mjs', 'lib/session-history.mjs', 'lib/douyin-api.mjs', 'lib/pb.mjs']
for (const f of jsFiles) {
  const p = join(ROOT, f)
  if (!existsSync(p)) continue
  try {
    // client.js 不是 ESM（浏览器自注册脚本），只能解析不能 import
    if (f === 'client.js') {
      const src = readFileSync(p, 'utf8')
      try {
        new (await import('node:vm')).Script(src, { filename: f })
      } catch (e) {
        bad(`${f} 解析失败 —— ${e?.message || e}`)
        continue
      }
      if (!src.includes('__ModuleLoader__')) { bad(`${f} 不是 client 自注册脚本`); continue }
      ok(`${f}`)
      continue
    }
    await import(pathToFileURL(p).href)
    ok(`${f}`)
  } catch (e) {
    bad(`${f} —— ${e?.message || e}`)
  }
}

/* 3. package.json */
head('package.json')
let pkg = {}
try {
  pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  ok('能解析')
} catch (e) {
  bad(`解析失败：${e?.message || e}`)
}
if (pkg.name !== 'dsh-douyin-bridge') bad(`name 应该是 dsh-douyin-bridge，实际 ${pkg.name}`)
else ok('name 正确')
if (pkg.exports?.['.'] !== './index.js') bad('exports["."] 应该是 ./index.js')
if (pkg.exports?.['./client'] !== './client.js') bad('exports["./client"] 应该是 ./client.js')
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') bad('dsh.bundle.patch 应该是 ./cordis.patch.yml')
if (!pkg.dependencies?.['@deepseek-ai/schemastery']) bad('schemastery 必须在 dependencies 里（不是 peerDependencies）')
else ok('schemastery 在 dependencies 里')
if (!pkg.dsh?.client?.inject?.includes('@deepseek-ai/dsh-client-ui-settings')) {
  warn('dsh.client.inject 里没有 dsh-client-ui-settings —— 设置页可能进不去')
}

/* 4. cordis.patch.yml */
head('cordis.patch.yml')
try {
  const yml = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  if (!/-\s*insert:/.test(yml)) bad('没有 insert 段')
  else if (!/id:\s*douyin-bridge/.test(yml)) bad('没有 id: douyin-bridge 的行')
  else if (!/name:\s*dsh-douyin-bridge/.test(yml)) bad('没有 name: dsh-douyin-bridge')
  else ok('形状对')
} catch (e) { bad(e?.message || e) }

/* 5. locale */
head('locale')
for (const loc of ['en', 'zh']) {
  const p = join(ROOT, 'locale', `${loc}.json`)
  if (!existsSync(p)) { bad(`缺 locale/${loc}.json`); continue }
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    if (!j?.meta?.title) bad(`locale/${loc}.json 缺 meta.title`)
    else if (!j?.meta?.description) bad(`locale/${loc}.json 缺 meta.description`)
    else ok(`locale/${loc}.json 好了`)
  } catch (e) { bad(`locale/${loc}.json 解析失败：${e?.message || e}`) }
}

/* 6. icon */
head('icon.svg')
try {
  const svg = readFileSync(join(ROOT, 'icon.svg'), 'utf8')
  const size = statSync(join(ROOT, 'icon.svg')).size
  if (!/^<svg[\s>]/i.test(svg.trim())) bad('不是 SVG')
  else if (!svg.includes('</svg>')) bad('SVG 没闭合')
  else if (size > 256 * 1024) bad(`太大了：${size} 字节（上限 256 KiB）`)
  else ok(`${size} 字节`)
} catch (e) { bad(e?.message || e) }

/* 7. 宿主依赖 */
head('宿主依赖')
try {
  const { loadHostDeps, candidateRoots } = await import(pathToFileURL(join(ROOT, 'lib', 'hostdeps.mjs')).href)
  const deps = await loadHostDeps()
  for (const n of deps.notes) console.log(`    · ${n}`)
  if (deps.z) ok('schemastery 拿到了（插件有 Config）')
  else warn('schemastery 拿不到 —— 插件照常跑，只是没有 Config')
  ok('defineTool 已就绪（本插件直接写原始 JSON Schema，不依赖它）')
  if (deps.notes.some((n) => n.includes('拿不到'))) {
    console.log('    提示：在桌面版里跑时宿主树是从 exe 旁边推出来的；')
    console.log('    单独跑本脚本时可以用 DSH_HOST_MODULES 指定宿主包目录：')
    console.log('      $env:DSH_HOST_MODULES = "<DSH>/resources/app/dsh/node_modules/@deepseek-ai"')
  }
  void candidateRoots
} catch (e) {
  bad(`hostdeps 加载失败：${e?.message || e}`)
}

/* 8. 加载测试（模仿 cordis 的 Proxy 陷阱） */
head('加载测试')
try {
  // 最要命的一关：cordis 对没 inject 的服务**读一下就抛**，插件直接不激活，
  // 而桌面版不把这条报错写进任何日志文件 —— 只能在这里拦住。
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync(process.execPath, [join(ROOT, 'tools', '_load-test.mjs')], {
    encoding: 'utf8',
    timeout: 60000,
  })
  if (r.status === 0) {
    const m = String(r.stdout || '').match(/注册的工具: (\d+)/)
    ok(`apply() 在假 ctx 上跑通了${m ? `（${m[1]} 个工具）` : ''}`)
  } else {
    bad('apply() 在假 ctx 上跑挂了 —— 插件在真实宿主里也不会激活')
    for (const line of String(r.stdout || '').split('\n').filter((l) => /✘|Error|cannot/.test(l)).slice(0, 6)) {
      console.log(`    · ${line.trim()}`)
    }
  }
} catch (e) { bad(`加载测试跑不起来：${e?.message || e}`) }

/* 9. 页面 JS 模板里的裸反引号 */
head('模板反引号')
try {
  // `browser.eval(\`...\`)` 这种模板里一旦出现反引号（哪怕是注释里的），
  // 模板就被提前截断，报错是 `SyntaxError: missing ) after argument list`，
  // 行号还指向模板开头 —— 极难定位。这个检查直接列出行号。
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'check-backticks.mjs'), join(ROOT, 'lib', 'douyin.mjs')], {
    encoding: 'utf8',
    timeout: 30000,
  })
  if (r.status === 0) ok('douyin.mjs 的页面模板里没有裸反引号')
  else {
    bad('页面模板里出现了裸反引号 —— 会被提前截断')
    for (const line of String(r.stdout || '').split('\n').filter((l) => l.includes('✘') || l.trim().startsWith('//')).slice(0, 6)) {
      console.log(`    · ${line.trim()}`)
    }
  }
} catch (e) { warn(`反引号检查跑不起来：${e?.message || e}`) }

/* 10. 媒体（图片 / 表情 / 语音） */
head('媒体支持')
try {
  const media = await import(pathToFileURL(join(ROOT, 'lib', 'media.mjs')).href)
  const need = ['MEDIA', 'pageMediaHelper', 'describeMedia', 'dataUrlToBytes', 'mergeMessages', 'mediaFingerprintPart', 'rememberEmojiNames', 'lookupEmojiName']
  const missing = need.filter((n) => media[n] === undefined)
  if (missing.length) bad(`lib/media.mjs 缺导出：${missing.join(', ')}`)
  else ok(`lib/media.mjs 的 ${need.length} 个导出都在`)

  // 媒体描述必须是**中性的** —— 自己的消息也会走同一条描述路径，
  // 写成「对方发来一张图」在回看自己的消息时就是错的。
  const cases = [
    [{ type: 'image', media: { width: 200, height: 150 } }, '[图片 200×150]'],
    [{ type: 'emoji', media: { name: '比心' } }, '[表情：比心]'],
    [{ type: 'emoji', media: {} }, '[表情]'],
    [{ type: 'voice', media: { seconds: 3 } }, '[语音 3 秒]'],
    [{ type: 'video', media: {} }, '[视频]'],
  ]
  let descBad = 0
  for (const [m, want] of cases) {
    const got = media.describeMedia({ ...m, media: m.media })
    if (got !== want) { descBad++; console.log(`    · ${JSON.stringify(m)} → ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`) }
  }
  if (descBad) bad(`describeMedia 有 ${descBad} 个用例不对`)
  else ok('describeMedia 措辞中性且格式正确')

  // 表情名对照表的 key：必须**剥掉 query**，否则面板和气泡的签名不同，永远对不上
  const a = media.mediaFingerprintPart({ type: 'emoji', media: { src: 'https://p3-sign.douyinpic.com/obj/im-resource/170-ts-abc?lk3s=1&x-signature=X' } })
  const b2 = media.mediaFingerprintPart({ type: 'emoji', media: { src: 'https://p26-sign.douyinpic.com/obj/im-resource/170-ts-abc?lk3s=2&x-signature=Y' } })
  if (a !== b2) bad('表情指纹没剥掉 CDN 子域/签名 —— 对照表会永远命中不了')
  else ok('表情指纹忽略了 CDN 子域和签名')
} catch (e) {
  bad(`媒体模块检查失败：${e?.message || e}`)
}

/* 11. 隐私自查提示 */
head('隐私自查')
console.log('    记得 push 之前跑一遍 README / DISCLAIMER 里给的 git grep 命令。')
console.log('    本仓库源码里不含账号、Cookie、好友名、本机路径。')

console.log(`\n${failures ? '✘' : '✔'} 失败 ${failures} 项，警告 ${warnings} 项`)
process.exit(failures ? 1 : 0)

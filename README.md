# dsh-douyin-bridge（刷抖音）

**把抖音私信接进 DSH。**

好友在抖音给你发消息 → 消息进 DSH 会话 → agent 拿到上下文 → agent 用工具反过来
刷视频、分享、把话回过去。

```
        抖音私信                                        DSH
   ┌───────────────┐                        ┌──────────────────────┐
   │  好友的消息    │──── 读 ─────────────▶│  注入 → 会话 → LLM   │
   │               │                        │                      │
   │  视频卡片      │◀─── 分享 / 回话 ──────│  douyin_* 工具       │
   └───────────────┘                        └──────────────────────┘
                                            ▲
                                   会话数据**全在这里**
```

---

## 它解决的是什么问题

`qq-bridge` 那套是：**QQ 客户端 → SnowLuma（OneBot 网关）→ DSH → LLM**，
会话数据全在 DSH 里。

抖音没有这种现成的网关。这个项目做的就是那一层：

| | QQ 那套 | 这个项目 |
| --- | --- | --- |
| IM 侧网关 | SnowLuma（现成） | **本插件自带**（浏览器 DOM 操作） |
| 桥接形态 | MCP server + 桥接进程 | **DSH 插件**（宿主半 + 浏览器半） |
| 消息进 DSH | `session/prompt` | **注入 DSH 会话**（`agent/inbox/spliced` + `user/message`） |
| 会话数据在哪 | DSH | **DSH**（本插件只留映射和去重指纹） |
| LLM 侧动作 | `mcp__snowluma__*` 工具 | **`douyin_*` 工具** |

也就是说：**这个插件扮演的是 SnowLuma 的角色**，只不过桥的是抖音私信而不是 QQ，
而且它直接长在 DSH 里，所以会话数据天然落在 DSH 的 session 日志中。

---

## 装

```bash
# 本地开发
dsh plugin --profile desktop add link:<这个目录>

# 或从 npm
dsh plugin --profile desktop add dsh-douyin-bridge
```

装完**重启一次 DSH**（bundle 层要重启才组装）。

然后：

1. 打开 **设置 → 刷抖音**
2. 点 **「打开浏览器登录」** —— 会弹出一个抖音网页版的 Edge/Chrome 窗口
3. 在那个窗口里扫码登录（用你要跟人聊的那个号）
4. **别关那个窗口**（登录态靠它）

之后它自己就开始轮询了。

> ⚠️ **桌面版（Electron）的 profile 只能由应用自己管。**
> `dsh plugin --profile desktop …` 会直接报
> `profile "desktop" is managed exclusively by the Electron application`。
> 桌面版请在 **设置 → 插件** 里装，或者用 `tools/dsh-rpc.mjs` 调
> `pluginManager/installBundle`（见 `tools/README.md`）。

### 排障：装上了但没反应

```bash
# ① 插件真的激活了吗（看 fiberPhase 是不是 active）
node tools/dsh-rpc.mjs pluginManager/listPlugins "{}" | grep -A2 douyin

# ② 桥接活着吗
node tools/dsh-rpc.mjs GET /dsh-douyin-bridge/status

# ③ 浏览器登录了没、会话列表读得到吗
node tools/dsh-rpc.mjs POST /dsh-douyin-bridge/stop
node tools/probe.mjs
```

**如果 `fiberPhase` 是 `failed`**，最常见的原因是**读了没声明 inject 的服务**：
cordis 对 `ctx.agents` 这种没声明过的服务是**抛异常**（不是返回 undefined），
插件直接不激活，而且这条错误不进任何日志文件。改完代码先跑：

```bash
node tools/_load-test.mjs    # 用假 ctx 复现 cordis 的 Proxy 陷阱
```

---

## 配置

真正的配置在 **`$DSH_HOME/douyin-bridge/config.json`**（不在插件目录里，
升级重装不会丢）。设置页能改的：

| 项 | 默认 | 意思 |
| --- | --- | --- |
| `mode` | `simulation` | `simulation` = AI 自己决定要不要回；`mirror` = AI 的每条回复自动发回抖音；`off` = 只给工具，不自动注入 |
| `peers` | `[]` | 好友白名单。空 = 所有会话都进 DSH（**自己发的消息永不回灌**） |
| `sharePeers` | `[]` | 允许把视频分享给谁。空 = 跟随 `peers` |
| `pollIntervalMs` | `20000` | 轮询间隔。别调太短（见下面的风控提示） |
| `maxInjectChars` | `4000` | 单条注入消息的字符上限 |
| `autoReply` | `true` | 收到新消息时自动唤醒 agent |
| `browserPort` | `47881` | CDP 端口 |
| `userDataDir` | `<家目录>/profile` | 浏览器 profile（登录态在这里） |

**`peers` 建议填上。** 空 = 所有会话都进 DSH，等于把你整个私信列表喂给模型。

---

## 工具（LLM 侧）

| 工具 | 干什么 |
| --- | --- |
| `douyin_search` | 搜视频 |
| `douyin_detail` | 读视频详情（**完整文案正文**、作者、时长、统计、话题） |
| `douyin_share` | 分享视频到私信（可捎一句话 `note`） |
| `douyin_dm_list` | 列出会话 |
| `douyin_dm_read` | 读某个好友的私信（图片/表情/语音/位置/视频/分享卡片都会标出类型） |
| `douyin_dm_send` | 发私信（纯文本） |
| `douyin_dm_send_image` | 发**图片**（本机文件，或 base64） |
| `douyin_dm_send_emoji` | 发**表情**（按名字，支持部分匹配） |
| `douyin_history` | 读某个好友的**完整历史**（从 DSH 会话日志，不受抖音虚拟列表限制） |
| `douyin_duty` | 读值班章程 |
| `douyin_status` | 看桥接状态（含当前模型、附件服务有没有挂上） |
| `douyin_whoami` | 看登录态 |
| `douyin_login` | 打开浏览器登录 |
| `douyin_selftest` | 选择器自检（改版时先跑这个） |

`douyin_share` / `douyin_dm_send` / `douyin_dm_send_image` / `douyin_dm_send_emoji`
的 `to` **留空 = 当前会话对应的好友**，所以在某个好友的会话里聊天时不用传参数。

发送类工具受白名单约束：`peers` 配了就只有名单里的人能收到消息。

### 图片是**真的**给模型看

对方发来图片时，桥接会：

1. 从 DOM 里把图片的 `data:` URL 抠出来（抖音网页端自己就把图转成 base64 内联了）
2. 用 `attachments.saveImages()` 存进 DSH 的附件库
3. 在注入的消息里挂一个 `{type:'image', attachment: ref}` 块

模型收到的是**图片本身**，不是「[图片 200×150]」这行字。

⚠️ **前提是模型支持图像输入**。文本模型收到 image 块时，DSH 会把它换成一句
`[image omitted because this model accepts text only; …]`，模型只看到一串 sha。

查当前模型支不支持：

```powershell
curl "http://127.0.0.1:<DSH端口>/dsh-douyin-bridge/models"   # 看 canSeeImage
curl "http://127.0.0.1:<DSH端口>/dsh-douyin-bridge/status"   # 看 agentModel / attachments
```

如果 `canSeeImage` 是 `false`，在 profile 的 `cordis.patch.yml` 里给那个模型补一行
（`dsh-llm-pi-ai` 的 catalog 不一定标对了能力，实测 MiniMax 就是漏标的）：

```yaml
- id: llm-pi-ai
  config:
    providers:
      <provider>:
        models:
          - id: <model>
            input: [text, image]     # ← 补这个
```

改完不用重启，`llm.listModels()` 会立刻读到新值。

---

## 值班章程

`prompts/duty.md` 是注入进桥接会话的系统提示（怎么回话、什么时候分享、什么不做）。
**你可以直接改它**，改完新会话立刻生效。

---

## 数据落在哪

| 数据 | 位置 |
| --- | --- |
| **对话正文** | **DSH 的 session 日志**（`~/.dsh/sessions/...`） |
| 好友名 ↔ session id 映射 | `$DSH_HOME/douyin-bridge/sessions.json` |
| 消息去重指纹 | 同上 |
| 配置 | `$DSH_HOME/douyin-bridge/config.json` |
| 抖音登录态 | `$DSH_HOME/douyin-bridge/profile/` |
| 运行日志 | `$DSH_HOME/douyin-bridge/bridge.log` |

**这个插件不另存对话副本。** 会话数据全在 DSH 里 —— 这是它跟一堆「自己搞个 jsonl
存聊天记录」的玩具脚本最本质的区别。

---

## 已知限制（说在前面）

- **抖音页面结构一变就可能失效。** 这不是「可能」，是「必然」。
  本仓库记录的所有 DOM 选择器都是在 2026-10 实测出来的。
- **视频页会被风控挡掉。** 短时间内开太多视频页会被重定向到 `/jingxuan`，
  这时候分享会失败。插件会返回 `VIDEO_UNAVAILABLE` 而不是假装成功。
- **私信面板需要足够宽的窗口**（≥1500px），窄窗口下面板会滑出视口。
- **轮询别太频繁。** 20 秒一轮是实测能用的节奏；5 秒一轮大概率触发风控。
- **私信只能读最近一屏**（抖音是虚拟列表），历史要靠 `scrollBack` 往上滚。
- **`mirror` 模式会重复发**的极端情况：agent 自己在会话里调 `douyin_dm_send`
  发的内容也会被 `mirror` 回发一遍。**同一时刻只用一种模式。**

---

## 踩过的坑（改代码前先看这段）

这些都是实测撞出来、已经修掉的，写在这里免得再踩一遍。

### 1. cordis 的服务读取会**抛异常**，不是返回 undefined

```js
// ✘ 整条插件不激活，而且错误不进日志
const agents = this.ctx.agents

// ✔ 两种安全写法
const agents = this.ctx.get('agents')          // 读不到 → undefined
ctx.inject(['agents'], (scoped) => { ... })    // scoped 上才有
```

`this.ctx?.agents` 也挡不住 —— 抛异常发生在 Proxy 的 get 陷阱里。
`tools/_load-test.mjs` 就是用来复现这件事的。

### 2. `agents.create()` **不会继承 profile 的默认模型**

不显式给 `provider` + `model`，turn 会以
`reason: error "has no provider/model"` 结束，而 **agent-loop 内部
`catch (_error) {}` 把异常吞掉了** —— 表现就是「注入了、turn 建了、
`llmMs: 0`、什么都没发生」。只能靠 `session/event` 的 `agent/error` 看到。

现在插件会去问 `agentDefaultModel.currentSelection()` 兜底。

### 3. 热重载时**别关浏览器**

宿主会先卸旧实例再装新实例。旧实例在 `dispose()` 里关浏览器，新实例刚连上的
页面就没了，表现为「面板没打开 / 进不去会话」。所以 `dispose()` 只
`detach()` 断连接，不杀进程。

### 4. 「消息」是 **toggle**，点两次会关掉

判断面板开没开，**只看会话项有没有尺寸**（`ConversationItemwrapper` 的 rect）。
以前用「宽度 250~600 且 innerText 含『消息』的 div」当判据，经常假阴性 ⇒
以为没开 ⇒ 又点一次 ⇒ 把开着的面板关掉 ⇒ 永远打不开。

### 5. 好友名要从 `ConversationItemtitle` 里取，并且**剥掉未读数和时间**

`innerText` 长这样：`好友名\n3\n03:27`（名字 / 未读数 / 时间）。整串当名字，后面按名字找人必然失配。

### 6. 聊天面板**没有**独立的会话头元素

当前在跟谁聊，信号是**左侧会话列表里被选中的那一项**。
用「尺寸 + 文字长度」去猜会抓到左侧导航的「精选」或者聊天区里的消息正文。

### 7. 发送前必须**确认进的是对的人**

`if (!st.inChat) await enterChat(...)` 把返回值丢掉，就会在没进去/进错会话时
照样打字 —— 消息发给上一个人，而工具还返回 `ok: true`。

### 8. 去重不能用「这条正文见过没有」

好友连发两个「1」，第二条会被判成重复 ⇒ 永远注入不进去。
现在用**窗口位移对比**（`DouyinBridge.newFrom`）：私信列表是滚动窗口，
这一轮 = 上一轮的后缀 + 新消息，找最大重合后缀，后面那段才是新的。

### 9. 整轮轮询要有超时

页面卡住时 `Runtime.evaluate` 会一直等，`busy` 卡住之后所有轮询都返回
`skipped: busy` —— 桥接看起来「活着但什么都不做」。

### 10. 页面里跑的 JS 用 `String.raw`

普通模板字符串会把 `\n` / `\d` 变成真换行，整个表达式直接语法错误。

### 11. **输入框可能在视口外** —— `insertText` 会静默失败

这条最阴。实测（dpr 1.25 的 1920×1080 屏）：

| 视口 | 现象 |
|---|---|
| 1532 宽 | 会话列表能出来，但**聊天输入框在 x=1707（视口外）** |
| 1532×791 | 面板可能干脆渲染不出来（DOM 里只有 0×0 的会话项） |

`Input.insertText` 只往「**当前焦点**」打字。输入框在视口外就点不到，
焦点留在 `BODY` 上 ⇒ 什么都没打进去，但代码只看「输入框空不空」就返回了
`ok: true` —— **假成功**，抖音里根本查不到这条。

现在的做法：

1. `growWindow()` 把真实窗口撑到 1920×1040（`Emulation.setDeviceMetricsOverride`
   不管用，抖音用自己算的宽度做布局）
2. 撑不动（有些屏 / 缩放会被系统夹回去）就用 **JS 直接 `focus()` + `execCommand('insertText')`**，
   不依赖坐标
3. 打完**回读输入框**，确认内容对得上
4. 按完 Enter 后**回读消息列表**，确认这条真的出现了 —— 才算成功

### 12. 「消息」按钮要按**叶子节点**逐层点

它的 DOM 是嵌套的（`UL > DIV > LI > DIV > DIV > DIV > P`），React 的 onClick
只挂在其中某一层。真实鼠标坐标点击容易落到没绑事件的容器上。

**但现在有更好的办法**：抖音页面里有一整套 `data-e2e` 测试锚点（见下条），
直接点 `[data-e2e="im-entry"]` 就行，不用猜层级。

### 13. ⭐ 抖音有稳定的 `data-e2e` 锚点，比 hash class 靠谱得多

实测（2026-10）页面里存在这些属性 —— 它们是**抖音自己的自动化测试在用的**，
比 `bJX7d7PL` 这种每次构建随机生成的 hash class 稳定得多：

| data-e2e | 是什么 | 实测尺寸 |
|---|---|---|
| `im-entry` | 「消息」入口按钮 | 32×44 |
| `im-dialog` | 私信面板容器 | 336×723 |
| `conversation-item` | 会话项 | 324×67 |
| `msg-item-content` | 消息内容块 | 166×40 |
| `msg-input` | 聊天输入框 | 334×44 |
| `searchbar-input` | 搜索框 | 422×38 |
| `searchbar-button` | 搜索按钮 | 80×38 |
| `douyin-navigation` | 左侧导航 | 160×675 |

所以 `lib/selectors.mjs` 的降级链**第一位永远放 `data-e2e`**，
第二位是语义 class 片段（`[class*="ConversationItemwrapper"]`），
最后才是结构 + 尺寸兜底。

### 14. 选择器失效要**报错**，不能静默

以前的表现是「工具返回 `ok: true` 但什么都没发生」—— 最难查。
现在：

- 启动 8 秒后自动跑一次 canary，挂了写日志
- `douyin_selftest` 工具 / `POST /dsh-douyin-bridge/selftest` 随时能查
- 输出里带「哪条降级链在生效」，改版时一眼看出该补哪条

### 15. 接口路（protobuf）已经写好了，但触发时机受限

`lib/pb.mjs` + `lib/douyin-api.mjs` 能把抖音的私信接口响应解出来
（实测解出 25 条消息、发送者、时间戳全对）。但有个硬限制：

**抖音只在「首次进某个会话」时请求 `get_by_conversation`，之后全走内存缓存。**
hook 只能截获「它装上之后」的请求，所以：

| 场景 | 结果 |
|---|---|
| hook 先装好 → 打开面板进会话 | ✅ 抓到 |
| 面板已打开 → 再装 hook | ❌ 0 条 |
| 反复读同一个会话 | ❌ 0 条（不重复请求） |

试过但**不通**的绕法（别再走一遍）：

- 直接 `fetch('imapi.douyin.com/...')` —— 请求体是「base64 外壳 + 内层 protobuf」
  的自定义帧，空 body 或乱拼都换不回数据
- 只靠 UI 切换会话 —— 切回来仍走缓存
- preload 注入 —— 需要「页面还没加载」这个时机，插件运行时早过了
- reload 兜底 —— 能用但一次 40 秒，轮询受不了

所以**主线还是 DOM**，接口层作为「有就用、没有就算了」的加速路径。
真要彻底摆脱 DOM，得逆向那套帧格式做纯协议客户端（2~3 天起步）。

---

## 媒体（图片 / 表情 / 语音）踩过的坑

### 16. 图片**不能**用 `box.querySelector('img')` 抓

每条消息盒子里**第一个 `img` 是头像**。直接 `querySelector('img')`
抓到的是 `p26.douyinpic.com/img/aweme-avat…`，看起来像图片地址，
其实跟消息内容毫无关系 —— 而且不会报错，只会「AI 看到的图永远是同一张头像」。

正确做法：**先定位类型容器，再取它里面的 img**。

```js
// ✅
const box = boxOf(message)
const img = box.querySelector('[class*="MessageItemImageImageBox"] img')
```

`lib/media.mjs` 里的 `imgOf(box, type)` 就是干这个的（`type` 决定容器 class）。

### 17. 消息图片是 **`data:` URL**，而且会被抖音重新编码

网页端发/收的图片，`img.src` 是 `data:image/png;base64,…`（不是 CDN 链接）。
一张 640×480 的 JPEG 进来，抖音会转成 PNG、缩到 576×432。
所以：

- 别指望拿 `src` 当「图片唯一标识」——不同会话里同一张图的 base64 可能不同
- 想比对就用 `mediaFingerprintPart()`，它只取长度和前后缀

### 18. 表情气泡里**没有名字**，只能靠面板对照表

表情气泡的 `innerText` 是空的，`img` 只有 CDN 地址、没有 `alt`/`title`。
唯一能拿到名字的地方是**表情面板**：每一格 `emojiEmojiItememojiItem` 的内文就是名字。

建表（`buildEmojiNameMap`）：打开面板 → 收集 `{src, name}` → Escape 关掉 → 缓存。

⚠️ 两个必踩的点：

1. **CDN 子域会变**（p3 / p5 / p9 / p11 / p26 都见过）
2. **签名参数每次都不同**（`?lk3s=…&x-signature=…`）

所以 key 必须取 `/obj/` 之后的**路径部分、且剥掉 query**：

```js
const key = String(src).split('/obj/')[1]?.split('?')[0] ?? ''
```

不剥 query 的话，面板里拿到的地址和气泡里的地址永远对不上，表情名永远是 `undefined`。

### 19. 虚拟列表会让「数一数有没有多一条」彻底失效

发图/发表情之后想验证「真的发出去了」，最容易想到的是数气泡个数。
**不行** —— 抖音是虚拟列表，新气泡进来的同时旧气泡会被卸载，个数经常原地不动（1 → 1）。

正确做法：**比对气泡 src 的集合**（`hasNewBubble(before, after)`）。

### 20. 发图片必须走 CDP 的 file chooser，`dispatchEvent` 点不开

点 `.semi-upload-add` 之后：

- ❌ 用 `Input.dispatchMouseEvent` 发真实鼠标事件 → 文件选择框**不弹**
- ✅ 用 JS `dispatchEvent` + `.click()` → 弹了

然后在**点之前**就开好拦截，否则事件错过：

```js
await browser.send('Page.setInterceptFileChooserDialog', { enabled: true })
const ev = browser.waitForEvent('Page.fileChooserOpened', { timeoutMs: 15000 })  // 先挂
await clickUploadIcon()
const { backendNodeId } = await ev
await browser.send('DOM.setFileInputFiles', { files: [path], backendNodeId })
```

最后点确认按钮要按 **class 前缀**点（`[class*="MsgInputSendFileModalbtnSure"]`），
点文字叶子节点没用。

### 21. 发表情是**直接发出去**的，没有二次确认

点面板里那一格 = 立刻发送，面板随即关闭。
所以 `douyin_dm_send_emoji` 没有「预览」这一步，名字写错就是发错。

### 22. `Emulation.setDeviceMetricsOverride` 必须带 `sessionId`

不带 `sessionId` 会报 `'Emulation.setDeviceMetricsOverride' wasn't found` ——
因为它挂在 page 级，不带 sessionId 就发到 browser 级去了，浏览器不认识这个方法。

但**就算带上了也救不了抖音**：视口改了、布局不重算，会话项还是 0×0。
唯一的办法是真的改窗口（`Browser.setWindowBounds`）。

### 23. ⭐ 改窗口大小会**把私信面板关掉**

这是最坑的一条。`ensurePanel` 里原来有一段「视口不够大就撑窗口」，
结果变成：**每读一次私信 → 撑一次窗口 → 把刚打开的面板关掉 → 报「面板没打开」**。
看起来像面板打不开，其实是自己关的。

更糟的是：屏幕 CSS 尺寸只有 1536×816（1920 物理 + 125% 缩放）时，
`setWindowBounds` 设 1920 会被系统**夹回 1536**，而 1532 宽下抖音的会话项
渲染成 **0×0** —— 面板等于没开。

所以现在的 `growWindow` 有两条早退：

```js
if (cur.w >= 1800 && cur.h >= 900) return false   // 已经够大
if (Number(cur.sw || 0) < 1800) return false      // 屏幕本身不够宽，别动
```

**屏幕不够宽怎么办**：把系统缩放调到 100%（或换更大的屏）。
1536 CSS px 是这台机器的硬上限，插件绕不过去。

### 24. 模型「看见图」和「看不见图」的区别在 `inputModalities`

`attachments.saveImages()` 只负责把图存下来。真正决定模型能不能看图的是
`llm` 层的 `modelInfo.inputModalities`：

```js
// @deepseek-ai/dsh-llm/lib/index.js
if (modelInfo.inputModalities !== void 0
    && !modelInfo.inputModalities.includes('image')
    && projectedMessages.some((m) => contentHasImage(m.content))) {
  projectedMessages = projectImagesForTextModel(projectedMessages)   // ← 图被换成一行字
}
```

而 `inputModalities` 来自 pi-ai catalog 里那条模型的 `input` 字段。
**catalog 会漏标**：MiniMax-M3.1-Flash 在 catalog 里写的是 `["text"]`，
但直连 Anthropic 协议接口实测它**能准确读出图里的文字**。
补一行 `input: [text, image]` 就好了，不用重启。

### 25. 验证「模型看见图了」要读**原始会话日志**

插件的 `/events` 接口只回 `type` / `seq` / `content` 摘要，**不含 reasoning**。
模型其实一眼就读出了图里的字，但都写在 reasoning 里 —— 摘要里看不到，
于是验证脚本误判「它看不到图」，白折腾好几轮。

要看全文就读 `$DSH_HOME/sessions/**/session.v4.jsonl.zstd`
（`lib/session-history.mjs` 的 `readSessionEvents`）。

---

## 隐私与合规

**先读 [DISCLAIMER.md](DISCLAIMER.md)。** 摘要：

- 这个项目**只用来学习研究，出了事不关作者的事**
- 你必须自己遵守**抖音的规定**和**法律法规**
- 插件会读你的私信 ⇒ **好友的消息会进模型上下文**，你选的模型服务商看得到
- **推到 GitHub 之前自己查一遍隐私**（DISCLAIMER 里给了自查命令）

---

## 致谢与许可

MIT。实现上参考了 `dsh-bili-scroll`（同为 MIT）与 DSH 内置的插件开发指引，
详见 [NOTICE.md](NOTICE.md)。

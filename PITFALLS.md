# 踩过的坑

这些是**改代码前**该知道的东西 —— 全是实测撞出来、已经修掉的，写在这里免得再踩一遍。

不想改代码的话可以跳过；只想用的话看 [README](README.md) 就够了。

---

## 目录

**DSH / cordis 侧**
1. [cordis 的服务读取会抛异常](#1-cordis-的服务读取会抛异常不是返回-undefined)
2. [`agents.create()` 不会继承默认模型](#2-agentscreate-不会继承-profile-的默认模型)
3. [热重载时别关浏览器](#3-热重载时别关浏览器)

**抖音 DOM 侧**

4. [「消息」是 toggle，点两次会关掉](#4-消息是-toggle点两次会关掉)
5. [好友名要剥掉未读数和时间](#5-好友名要从-conversationitemtitle-里取并且剥掉未读数和时间)
6. [聊天面板没有独立的会话头](#6-聊天面板没有独立的会话头元素)
7. [发送前必须确认进的是对的人](#7-发送前必须确认进的是对的人)
8. [去重不能用「这条正文见过没有」](#8-去重不能用这条正文见过没有)
9. [整轮轮询要有超时](#9-整轮轮询要有超时)
10. [页面里的 JS 用 `String.raw`](#10-页面里跑的-js-用-stringraw)
11. [输入框可能在视口外](#11-输入框可能在视口外-inserttext-会静默失败)
12. [「消息」按钮要按叶子节点点](#12-消息按钮要按叶子节点逐层点)
13. [`data-e2e` 锚点最稳](#13-抖音有稳定的-data-e2e-锚点比-hash-class-靠谱得多)
14. [选择器失效要报错](#14-选择器失效要报错不能静默)
15. [接口路的触发时机受限](#15-接口路protobuf已经写好了但触发时机受限)

**媒体（图片 / 表情 / 语音）**

16. [图片不能用 `querySelector('img')`](#16-图片不能用-boxqueryselectorimg-抓)
17. [消息图片是 `data:` URL](#17-消息图片是-data-url而且会被抖音重新编码)
18. [表情气泡里没有名字](#18-表情气泡里没有名字只能靠面板对照表)
19. [虚拟列表让「数个数」失效](#19-虚拟列表会让数一数有没有多一条彻底失效)
20. [发图片必须走 CDP file chooser](#20-发图片必须走-cdp-的-file-chooserdispatchevent-点不开)
21. [发表情是直接发出去的](#21-发表情是直接发出去的没有二次确认)
22. [`Emulation` 必须带 sessionId](#22-emulationsetdevicemetricsoverride-必须带-sessionid)
23. [改窗口大小会关掉面板](#23-改窗口大小会把私信面板关掉)
24. [模型能不能看图看 `inputModalities`](#24-模型看见图和看不见图的区别在-inputmodalities)
25. [验证看图要读原始日志](#25-验证模型看见图了要读原始会话日志)

---

## DSH / cordis 侧

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

另外：`inject` 的回调**会等所有依赖都到位才跑**。所以别把「可有可无」的服务
（比如 `attachments`）和必需的（`agents`）塞进同一个 inject 数组 ——
少了那个可有可无的，整条腿就永远不启动。本插件是分开 inject 的。

### 2. `agents.create()` 不会继承 profile 的默认模型

不显式给 `provider` + `model`，turn 会以
`reason: error "has no provider/model"` 结束，而 **agent-loop 内部
`catch (_error) {}` 把异常吞掉了** —— 表现就是「注入了、turn 建了、
`llmMs: 0`、什么都没发生」。只能靠 `session/event` 的 `agent/error` 看到。

现在插件会去问 `agentDefaultModel.currentSelection()` 兜底。

### 3. 热重载时**别关浏览器**

宿主会先卸旧实例再装新实例。旧实例在 `dispose()` 里关浏览器，新实例刚连上的
页面就没了，表现为「面板没打开 / 进不去会话」。所以 `dispose()` 只
`detach()` 断连接，不杀进程。

热重载还会留僵尸实例（旧 fiber 还在跑轮询），日志会无限刷屏。
真遇到了用 `node tools/reinstall.mjs` 彻底移除再装。

---

## 抖音 DOM 侧

### 4. 「消息」是 **toggle**，点两次会关掉

判断面板开没开，**只看会话项有没有尺寸**（`ConversationItemwrapper` 的 rect）。
以前用「宽度 250~600 且 innerText 含『消息』的 div」当判据，经常假阴性 ⇒
以为没开 ⇒ 又点一次 ⇒ 把开着的面板关掉 ⇒ 永远打不开。

### 5. 好友名要从 `ConversationItemtitle` 里取，并且**剥掉未读数和时间**

`innerText` 长这样：`好友名\n3\n03:27`（名字 / 未读数 / 时间）。
整串当名字，后面按名字找人必然失配。

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

媒体消息还要额外把媒体特征拼进指纹 —— 两张不同的图正文都是
`[图片 200×150]`，只按正文算会把第二张吃掉。

### 9. 整轮轮询要有超时

页面卡住时 `Runtime.evaluate` 会一直等，`busy` 卡住之后所有轮询都返回
`skipped: busy` —— 桥接看起来「活着但什么都不做」。

### 10. 页面里跑的 JS 用 `String.raw`

普通模板字符串会把 `\n` / `\d` 变成真换行，整个表达式直接语法错误。

更坑的是**模板里出现裸反引号**（哪怕在注释里）会把模板提前截断，
报错是 `SyntaxError: missing ) after argument list`，行号还指向模板开头。
`tools/check-backticks.mjs` 专门扫这个，`selfcheck.mjs` 会调它。

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

还有一个更深的坑：**页面内的 XHR hook 会被抖音覆盖**。
抖音在 document-start 之后重新包了一遍 `XMLHttpRequest.prototype.send`，
我们挂的 hook 还在，但再也收不到东西（hook 存在、日志长度永远是 0）。
所以接口路的抓包走的是 **CDP 的 `Network.responseReceived` + `Network.getResponseBody`**
（浏览器层，页面改不动）。

`getResponseBody` 拿到的 base64 **必须保持 Buffer**。解码成 utf8 再编码回去，
非 UTF-8 字节会变成 `ef bf bd`（U+FFFD），protobuf 直接解不出来。

所以**主线还是 DOM**，接口层作为「有就用、没有就算了」的加速路径。
真要彻底摆脱 DOM，得逆向那套帧格式做纯协议客户端（2~3 天起步）。

---

## 媒体（图片 / 表情 / 语音）

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

另外别只在「表是空的」时才建表 —— 抖音会不断上新表情，
表里没有的那一个会永远显示成 `[表情]`。正确顺序是：先按现有表查，
**还有查不到的**就重建一次表再查。

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

完整的发送链路（实测抓到的请求顺序）：

```
GET  /aweme/v1/web/im/upload/config/v2
GET  vod.bytedanceapi.com?Action=ApplyUploadInner&FileType=image
POST https://tos-d-x-hl.douyin.com/upload/v1/tos-cn-o-00061/…
POST vod.bytedanceapi.com?Action=CommitUploadInner
POST https://imapi.douyin.com/v1/message/send
GET  /aweme/v1/web/privacy/batch_build_image/
```

### 21. 发表情是**直接发出去**的，没有二次确认

点面板里那一格 = 立刻发送，面板随即关闭。
所以 `douyin_dm_send_emoji` 没有「预览」这一步，名字写错就是发错。

表情按钮的选择器是 `svg.messageMsgInputiconAction`，面板容器是
`[class*="emojiPanel"]` —— 注意**小写** `emoji`，写成 `emojiEmojiPanel` 匹配不到。

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
1536 CSS px 是硬上限，插件绕不过去。

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

插件加了 `GET /dsh-douyin-bridge/models` 直接查：

```bash
node tools/dsh-rpc.mjs GET /dsh-douyin-bridge/models
# 看哪个模型的 canSeeImage 是 true
```

### 25. 验证「模型看见图了」要读**原始会话日志**

插件的 `/events` 接口只回 `type` / `seq` / `content` 摘要，**不含 reasoning**。
模型其实一眼就读出了图里的字，但都写在 reasoning 里 —— 摘要里看不到，
于是验证脚本误判「它看不到图」，白折腾好几轮。

要看全文就读 `$DSH_HOME/sessions/**/session.v4.jsonl.zstd`
（`lib/session-history.mjs` 的 `readSessionEvents`）。

`tools/probe-vision.mjs` 就是按这个思路写的：画一张写着字的图 → 注入 →
从原始日志里找模型有没有把那些字说出来。

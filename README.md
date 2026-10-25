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
| `douyin_dm_read` | 读某个好友的私信 |
| `douyin_dm_send` | 发私信 |
| `douyin_duty` | 读值班章程 |
| `douyin_status` | 看桥接状态 |
| `douyin_whoami` | 看登录态 |
| `douyin_login` | 打开浏览器登录 |

`douyin_share` / `douyin_dm_send` 的 `to` **留空 = 当前会话对应的好友**，
所以在某个好友的会话里聊天时不用传参数。

发送类工具受白名单约束：`peers` 配了就只有名单里的人能收到消息。

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
现在按「叶子 → 逐层往上」挨个 `dispatchEvent`，点完检查会话项有没有尺寸。

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

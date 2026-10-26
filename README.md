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

> 💡 **窗口关掉了不会再自己弹回来。**
> 你要是手动把浏览器关了，桥会**停下来**（不会每隔几秒弹一个窗口骚扰你），
> 日志里会写「浏览器窗口被关掉了 —— 桥接暂停」。
> 想让它回来：再点一次 **「打开浏览器登录」**，或者
> `POST /dsh-douyin-bridge/start`。
> 浏览器**自己崩了**的话会自动重连（30 秒一次，最多 3 次）。

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
| `douyin_comment_list` | 列出某个视频下的评论（挑要处理的那一条） |
| `douyin_comment_post` | 在视频下**发评论** |
| `douyin_comment_share` | 把**某条评论**分享给某个好友（对方收到评论卡片） |
| `douyin_dm_list` | 列出会话 |
| `douyin_dm_read` | 读某个好友的私信（图片/表情/语音/位置/视频/分享卡片都会标出类型） |
| `douyin_dm_send` | 发私信（纯文本） |
| `douyin_dm_send_image` | 发**图片**（本机文件，或 base64） |
| `douyin_dm_send_emoji` | 发**表情**（按名字，支持部分匹配） |
| `douyin_sticker_grab` | 把视频评论区里的表情**收集到本地表情库** |
| `douyin_sticker_list` | 看本地表情库 |
| `douyin_sticker_send` | 从本地表情库发一个给好友 |
| `douyin_sticker_remove` | 从库里删一个 |
| `douyin_history` | 读某个好友的**完整历史**（从 DSH 会话日志，不受抖音虚拟列表限制） |
| `douyin_duty` | 读值班章程 |
| `douyin_status` | 看桥接状态（含当前模型、附件服务有没有挂上） |
| `douyin_whoami` | 看登录态 |
| `douyin_login` | 打开浏览器登录 |
| `douyin_selftest` | 选择器自检（改版时先跑这个） |

`douyin_share` / `douyin_dm_send` / `douyin_dm_send_image` / `douyin_dm_send_emoji`
的 `to` **留空 = 当前会话对应的好友**，所以在某个好友的会话里聊天时不用传参数。

发送类工具受白名单约束：`peers` 配了就只有名单里的人能收到消息。

### 评论区

`douyin_comment_list` → `douyin_comment_post` / `douyin_comment_share` 是三步走：

```text
douyin_comment_list   { video: "7697459346984897955" }
  → { comments: [ { i: 0, author: "…", text: "…", hasShare: true }, … ] }

douyin_comment_post   { video: "…", text: "这条猫也太可爱了" }
  → { ok: true, posted: true, comment: "…" }

douyin_comment_share  { video: "…", index: 0, to: "某个好友" }
  → { ok: true, sent: true, target: "某个好友" }
```

分享出去的评论，好友那边会收到一条卡片，内容形如
`分享 @某人 的评论 「…」，来自视频 「…」`。

⚠️ **发评论会被抖音要求人机验证**（新号常见）。工具会返回
`{ ok: false, code: "NEEDS_VERIFY" }` 并带上被遮的手机号尾号；
到浏览器里把短信验证码填了点「验证」之后，这个号就能正常发评论了。
这不是 bug，是抖音的风控，代码绕不过去。

### 本地表情库

抖音**没有收藏表情的接口**，UI 上也没有入口（表情面板只有「表情 / GIF」
两个 tab，格子上 hover、右键都没反应）。所以这里走的是另一条路：

```text
douyin_sticker_grab  { video: "…" }
  → 把评论区里的表情图全抓下来，存进本地库
  → { ok: true, candidates: 32, saved: 32, library: { total: 32, kinds: {…} } }

douyin_sticker_list  { query: "猫" }
  → { stickers: [ { id: "3bf853fc8482", name: "1f49a", ext: ".png" }, … ] }

douyin_sticker_send  { sticker: "3bf853fc8482", to: "某个好友" }
  → { ok: true, verified: true }
```

为什么这条路是稳的：

- 评论区里的表情本身就是**普通 CDN 图片**（`p*-pc-sign.douyinpic.com`、
  `byteimg.com/…/twemoji/`），Node 直接 `fetch` 就是 200，连 referer 都不用带
- 发送复用已经跑通的发图链路（`sendImage`），不需要碰表情面板
- **webp 会自动转 png** —— 抖音的上传控件不认 webp，塞进去只会得到
  「选完文件后没弹出发送确认框」，而且报错完全不提格式

库落在 `$DSH_HOME/douyin-bridge/stickers/`，`index.json` 是清单，图片按
内容指纹命名（同一张图只存一份）。

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

## 已知限制

- **抖音改版就会失效。** 本仓库的 DOM 选择器都是 2026-10 实测的。
  失效时先跑 `node tools/probe-canary.mjs` 看哪条降级链挂了。
- **视频页会被风控挡掉。** 短时间开太多视频页会被重定向到 `/jingxuan`，
  分享会失败。插件返回 `VIDEO_UNAVAILABLE`，不会假装成功。
- **私信面板需要够宽的屏幕。** 视口 <1800 CSS px 时面板渲染成 0×0。
  屏幕本身不够宽的话（比如 1920 物理 + 125% 缩放 = 1536 CSS px），
  把系统缩放调到 100%。
- **轮询别太频繁。** 20 秒一轮是实测能用的节奏；5 秒一轮大概率触发风控。
- **私信只能读最近一屏**（虚拟列表），历史要靠 `scrollBack` 往上滚。
  想看完整历史用 `douyin_history`（读 DSH 会话日志，不受这个限制）。
- **`mirror` 模式有重复发的风险**：agent 自己调 `douyin_dm_send` 发的内容
  也会被 `mirror` 回发一遍。同一时刻只用一种模式。
- **发评论会触发人机验证。** 新号在抖音发评论经常弹短信验证码，
  工具会报 `NEEDS_VERIFY` 而不是假装成功；人工过一次之后这个号就正常了。
- **分享评论只在视频页布局下能展开「分享给朋友」**（`/video/<id>`）。
  沉浸式浮层（`?modal_id=`）里点「分享」点不开 —— 所以这两个动作走的是两条打开策略。
- **语音只能读、不能发。** 网页端没找到发送入口。

---

## 想改代码？

抖音的页面结构、cordis 的坑、媒体的坑，全在 **[PITFALLS.md](PITFALLS.md)**。
30 条，都是实测撞出来又修掉的 —— 改之前先扫一眼，能省很多时间。

几条最要命的先放这：

- `ctx.agents` 读一下**就抛异常**（不是 undefined），整条插件会不激活，而且不报错
- 改浏览器窗口大小会**把私信面板关掉**
- 发消息只看「输入框空不空」会**假成功** —— 输入框可能在视口外，`insertText` 静默失败

---

## 隐私与合规

**先读 [DISCLAIMER.md](DISCLAIMER.md)。** 摘要：

- 本项目**只用于学习研究**，使用后果由使用者自行承担
- 你必须自行遵守**抖音的平台规则**和**适用法律法规**
- 插件会读你的私信 ⇒ **好友的消息会进模型上下文**，你选的模型服务商看得到
- **推到 GitHub 之前自己查一遍隐私**（DISCLAIMER 里给了自查命令）

---

## 致谢与许可

MIT。实现上参考了 `dsh-bili-scroll`（同为 MIT）与 DSH 内置的插件开发指引，
详见 [NOTICE.md](NOTICE.md)。

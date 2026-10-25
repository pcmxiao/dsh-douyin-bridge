# tools/ —— 开发与排障脚本

这些不是插件运行时的一部分，是**给你自己排障用的**。插件装好之后可以不管它们。

| 脚本 | 干什么 |
|---|---|
| `_load-test.mjs` | 用假的 ctx 跑一遍 `apply()`，**模仿 cordis 的 Proxy 陷阱**（没 inject 的服务一读就抛）。`selfcheck.mjs` 会调它。 |
| `dsh-rpc.mjs` | 直接打 DSH 的 Web API（离线签一个 browser-session cookie），用来调 `pluginManager/*` 和插件自己的 HTTP 接口。 |
| `reinstall.mjs` | 彻底移除再装一遍插件。热重载会留僵尸实例，日志刷屏时用它。 |
| `check-backticks.mjs` | 扫 `lib/douyin.mjs` 里页面 JS 模板中的**裸反引号**（会把模板提前截断，报错行号还指错地方）。 |
| `probe.mjs` | 问浏览器：登录了没、会话列表读得到吗、当前开的是谁的会话。 |
| `probe-dm.mjs` | 端到端：进某个好友的聊天 → 读消息 → 可选发一条 → 读回验证。 |
| `probe-media.mjs` | 探测私信面板里**非文本消息**的 DOM 结构（图片/表情/语音），以及工具栏按钮怎么点。 |
| `probe-media-chain.mjs` | **媒体链路全跑一遍**：读（认图片/表情/语音）→ 发表情 → 发图片，每步验证气泡真的出现。 |
| `probe-vision.mjs` | **决定性测试**：画一张有字的图注入会话，看模型能不能说出图里的字。判断「AI 到底看不看得见图」就靠它。 |
| `probe-canary.mjs` | **选择器自检**：逐个探测关键选择器，看哪条降级链在生效、哪条全挂了。抖音改版后先跑这个。 |
| `session-log.mjs` | 解压并打印 DSH 的会话事件（`session.v4.jsonl.zstd`），看 LLM 到底回了什么。 |
| `shot.mjs` | 截一张图。工具返回 ok 但没反应时，截图一眼就知道卡在哪。 |

## 常见用法

```bash
# 加载测试（改完 index.js 先跑这个）
node tools/_load-test.mjs

# 浏览器到底登没登录、能不能读到会话列表
node tools/probe.mjs

# 读某个好友的私信
node tools/probe-dm.mjs "好友名"

# 读 + 发一条 + 读回验证
node tools/probe-dm.mjs "好友名" --send "测试"

# 图片/表情/语音：读一遍 + 发表情 + 发图片，每步都验证
node tools/probe-media-chain.mjs "好友名"

# AI 到底能不能看见对方发的图？（画字图 → 注入 → 看模型说不说得出来）
node tools/probe-vision.mjs

# 看桥接会话的 LLM 输出
node tools/session-log.mjs            # 列出所有 douyin-* 会话
node tools/session-log.mjs "<sessionId>"

# 抖音改版了？先跑选择器自检，看哪条降级链挂了
node tools/probe-canary.mjs

# 卡住了？截个图看看页面长什么样
node tools/shot.mjs

# 调插件自己的 HTTP 接口（要 DSH 在跑）
node tools/dsh-rpc.mjs GET /dsh-douyin-bridge/status
node tools/dsh-rpc.mjs GET /dsh-douyin-bridge/models      # 看哪个模型能看图
node tools/dsh-rpc.mjs POST /dsh-douyin-bridge/poll
node tools/dsh-rpc.mjs POST /dsh-douyin-bridge/selftest
node tools/dsh-rpc.mjs POST /dsh-douyin-bridge/inject "@args.json"

# 调 DSH 的 RPC（插件管理）
node tools/dsh-rpc.mjs pluginManager/listPlugins "{}"
```

## 注意

- `probe*.mjs` 会和桥接**抢同一个页面**。跑之前先在设置页点「停止」，或
  `node tools/dsh-rpc.mjs POST /dsh-douyin-bridge/stop`。
- `probe-media-chain.mjs` 会**真的发消息**给对方。
- `dsh-rpc.mjs` 会从 `$DSH_HOME/.credentials.yaml` 读 `client-connection/browser-session`
  的密钥来签 cookie。**它只在本机跑得通，也不要把它里面的东西贴出去。**
- Windows 下命令行传 JSON 会被 PowerShell 吃掉引号，所以 JSON 参数用 `@文件` 形式。
- ⚠️ **别用 PowerShell 的 `Set-Content` / `Out-File` 改这些 .mjs 文件** ——
  默认编码会把中文写成乱码（`鈥斺€`），文件直接语法报错。用编辑器或 `write` 工具。

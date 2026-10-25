# NOTICE

本项目在实现上参考了以下开源项目（**代码风格与部分技术手法同源**，非整段复制）：

- **dsh-bili-scroll**（MIT，https://github.com/c1overzz/dsh-bili-scroll）
  —— DSH 插件的整体形态（`index.js` 宿主半 + `client.js` 浏览器半 + `cordis.patch.yml`
  自带挂载声明 + `prompts/duty.md` 值班章程 + 设置页进 `settings.section` 槽位）、
  以及 `lib/hostdeps.mjs` 里「从宿主那棵树里取 `@deepseek-ai/*`、取不到就退回本地等价实现」
  这条策略。

  本仓库里的 `lib/hostdeps.mjs` 是按本插件需要**重写**的版本，只保留了同一条思路。

- **DeepSeek Harness 插件开发指引**（`@deepseek-ai/dsh-agent-preset` 内置 skill
  `cordis-plugin-development`）
  —— 宿主半导出形态、`cordis.patch.yml` 的 patch 方言、浏览器半的
  `window.__ModuleLoader__.load()` 自注册约定、设置页槽位写法。

本项目 **不使用** 任何第三方 IM 网关的代码；抖音侧全部操作通过浏览器 DOM 完成，
不依赖任何私有接口。

MIT 许可条款见 [LICENSE](LICENSE)。

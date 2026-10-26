/**
 * lib/selectors.mjs —— 选择器注册表（**唯一真相**）
 * ============================================================================
 * 为什么要有这个文件：
 *
 * 抖音的 class 名是**每次构建随机生成的 hash**（`bJX7d7PL`、`o2tLobnl` 这种），
 * 但语义化的部分（`ConversationItemwrapper`、`messageMessageBox`）是稳定的 ——
 * 因为那是抖音自己的 CSS Modules 命名，改版时一般不动。
 *
 * 所以策略是**多级降级**：
 *
 *   ① `data-e2e="..."`      —— 抖音自己的测试属性，最稳（他们测试要用）
 *   ② 语义 class 片段       —— `[class*="ConversationItemwrapper"]`
 *   ③ ARIA / role 语义      —— `[role="listitem"]`
 *   ④ 结构 + 文本兜底       —— 尺寸 + innerText 匹配
 *
 * 每一组按顺序试，第一个有结果的就用。全挂了就明确报 `SELECTOR_BROKEN`，
 * **不假装成功** —— 静默失败比报错更难查（这个项目已经踩过好几次）。
 *
 * 用法：
 *   const items = await pick(browser, SEL.conversationItem)
 *   // items 是 Element[] 的序列化结果，空数组表示全挂了
 */

/**
 * 选择器组。每个 key 是一个**降级链**，前面的优先。
 *
 * ⭐ 实测（2026-10）抖音页面里有一整套 `data-e2e` 测试锚点，
 *    这是**抖音自己的自动化测试在用的属性**，比随机 hash class 稳定得多：
 *
 *      im-entry             「消息」入口按钮（32×44）
 *      im-dialog            私信面板容器（336×723）
 *      conversation-item    会话项（324×67）
 *      msg-item-content     消息内容（166×40）
 *      msg-input            聊天输入框（334×44）
 *      searchbar-input      搜索框
 *      searchbar-button     搜索按钮
 *      douyin-navigation    左侧导航
 *
 *    改版时这些属性一般不动 —— 所以放在降级链**第一位**。
 */
export const SEL = {
  /** 「消息」入口按钮（打开私信面板的那个） */
  msgEntry: [
    '[data-e2e="im-entry"]',
  ],

  /** 私信面板容器 */
  msgDialog: [
    '[data-e2e="im-dialog"]',
    '[class*="LeftPanelwrapper"]',
  ],

  /** 会话列表里的一项 */
  //
  // 🔴 真实的 class 是 `conversationConversationItemwrapper`（**大写 I**）。
  //    以前写的 `[class*="conversationItem"]` 是小写 i，
  //    而 CSS 属性选择器**区分大小写** ⇒ 永远匹配 0 个。
  //    症状极具误导性：面板明明渲染了、DOM 里会话就在眼前，
  //    但 dmList 返回 0 条，桥接于是报「找不到会话」。
  conversationItem: [
    '[data-e2e="conversation-item"]',
    '[class*="conversationConversationItemwrapper"]',
    '[class*="ConversationItemwrapper"]',
    '[class*="conversationItem"]',
  ],

  /** 会话项里的好友名 */
  conversationTitle: [
    '[data-e2e="conversation-title"]',
    '[class*="conversationConversationItemtitle"]',
    '[class*="ConversationItemtitle"]',
    '[class*="conversationTitle"]',
  ],

  /** 会话项里的时间 */
  conversationTime: [
    '[class*="ConversationItemTagNextToTitle"]',
    '[class*="TagNextToTitle"]',
    '[class*="conversationTime"]',
  ],

  /** 会话项里的消息预览 */
  conversationDesc: [
    '[class*="ConversationItemDesc"]',
    '[class*="conversationDesc"]',
  ],

  /** 一条消息的外层容器 */
  messageBox: [
    '[data-e2e="message-item"]',
    'div[class*="messageMessageBox"][class*="messageBox"]',
    'div[class*="messageMessageBox"]',
  ],

  /** 消息正文块 */
  messageContent: [
    '[data-e2e="msg-item-content"]',
  ],

  /** 自己发的消息上的标记 */
  fromMe: [
    '[class*="isFromMe"]',
    '[data-e2e="message-from-me"]',
  ],

  /** 分享视频卡片 */
  shareCard: [
    '[class*="MessageItemShareAweme"]',
    '[data-e2e="share-aweme"]',
  ],

  /** 聊天输入框（contenteditable） */
  chatInput: [
    '[data-e2e="msg-input"] [contenteditable="true"]',
    '[data-e2e="msg-input"]',
    '[contenteditable="true"]',
  ],

  /** 聊天输入框（textarea 变体） */
  chatTextarea: [
    'textarea',
  ],

  /** 未读红点 */
  unreadBadge: [
    '[class*="Badge"]',
    '[class*="RedPoint"]',
    '[class*="Dot"]',
  ],

  /** 搜索框 */
  searchInput: [
    '[data-e2e="searchbar-input"]',
    'input[type="search"]',
  ],

  /** 搜索按钮 */
  searchButton: [
    '[data-e2e="searchbar-button"]',
  ],

  /** 视频分享按钮（视频页） */
  shareButton: [
    '[data-e2e="video-share-icon-container"]',
    '[data-e2e="share-icon"]',
  ],

  /** 搜索结果的视频卡片 */
  searchCard: [
    '.search-result-card',
    '[data-e2e="search-result-card"]',
    'li[class*="search"]',
  ],

  /** 搜索页里指向视频的链接 */
  videoLink: [
    'a[href*="/video/"]',
  ],

  /** 搜索页里指向用户的链接 */
  userLink: [
    'a[href*="/user/"]',
  ],
}

/**
 * 把一组选择器编译成「在页面里跑的 JS 片段」。
 *
 * 返回的字符串会被塞进 `browser.eval` 的模板里，所以不能有反引号。
 *
 * @param {string[]} chain
 * @param {string} varName 生成的变量名
 * @returns {string} 形如 `const items = (() => { ... })()`
 */
export function compilePick(chain, varName = 'items') {
  const list = JSON.stringify(chain)
  return `const ${varName} = (() => {
    const CHAIN = ${list};
    for (const sel of CHAIN) {
      try {
        const found = [...document.querySelectorAll(sel)];
        if (found.length) return found;
      } catch (e) { /* 选择器语法不支持就跳过 */ }
    }
    return [];
  })()`
}

/**
 * 找出「哪一级命中了」—— 用来记日志，知道哪条降级路径在生效。
 *
 * @param {object} browser
 * @param {string[]} chain
 * @returns {Promise<{selector:string, count:number}>}
 */
export async function whichHits(browser, chain) {
  try {
    return await browser.eval(`(() => {
      const CHAIN = ${JSON.stringify(chain)};
      for (const sel of CHAIN) {
        try {
          const n = document.querySelectorAll(sel).length;
          if (n) return { selector: sel, count: n };
        } catch (e) {}
      }
      return { selector: '', count: 0 };
    })()`)
  } catch {
    return { selector: '', count: 0 }
  }
}

/**
 * 生成一段「页面内多级降级查找」的 JS。
 *
 * 这是给 `String.raw` 模板用的 —— 输出的是**页面里能直接跑的表达式**，
 * 会按注册表顺序试，返回第一个有结果的。
 *
 * 用法（在页面 JS 里）：
 *   const FIND = ${pageFindHelper()}
 *   const items = FIND.conversationItem()
 *   const title = FIND.one(el, 'conversationTitle')
 *
 * ⚠️ 输出里不能有反引号（会被外层模板字符串截断）。
 *
 * @returns {string}
 */
export function pageFindHelper() {
  return `(() => {
    const CHAINS = ${JSON.stringify({
      conversationItem: SEL.conversationItem,
      conversationTitle: SEL.conversationTitle,
      conversationTime: SEL.conversationTime,
      conversationDesc: SEL.conversationDesc,
      messageBox: SEL.messageBox,
      fromMe: SEL.fromMe,
      shareCard: SEL.shareCard,
      chatInput: SEL.chatInput,
      unreadBadge: SEL.unreadBadge,
    })};
    const all = (key) => {
      for (const sel of (CHAINS[key] || [])) {
        try {
          const found = [...document.querySelectorAll(sel)];
          if (found.length) return found;
        } catch (e) {}
      }
      return [];
    };
    const one = (root, key) => {
      if (!root) return null;
      for (const sel of (CHAINS[key] || [])) {
        try {
          const found = root.querySelector(sel);
          if (found) return found;
        } catch (e) {}
      }
      return null;
    };
    const out = { all, one };
    for (const k of Object.keys(CHAINS)) out[k] = () => all(k);
    return out;
  })()`
}

/**
 * 跑一遍所有关键选择器，报告哪些还能用。
 *
 * 这是 canary 自检的核心 —— 插件启动时 / 排障时调一次，
 * 就能知道「是不是抖音改版把选择器打挂了」。
 *
 * @param {object} browser
 * @returns {Promise<{ok:boolean, broken:string[], working:object}>}
 */
export async function canary(browser) {
  const keys = [
    'msgEntry',
    'msgDialog',
    'conversationItem',
    'conversationTitle',
    'messageBox',
    'messageContent',
    'fromMe',
    'chatInput',
    'searchInput',
  ]
  const working = {}
  const broken = []

  for (const key of keys) {
    const r = await whichHits(browser, SEL[key])
    working[key] = r
    if (!r.count) broken.push(key)
  }

  // 关键项：只放「无论在什么页面状态都该存在」的。
  //
  // ⚠️ 不要把 chatInput / messageBox / fromMe 放进关键项：
  //    它们只在「已经进了某个聊天」时才渲染。面板开着但停在会话列表时
  //    它们本来就是 0 —— 那是正常状态，不是改版。
  //    放进关键项会导致每次自检都误报（踩过）。
  const critical = ['msgEntry', 'conversationItem']
  const criticalBroken = broken.filter((k) => critical.includes(k))

  return {
    ok: criticalBroken.length === 0,
    broken: criticalBroken,
    /** 非关键项里没命中的（可能只是当前页面没到那一步，不一定是改版） */
    absent: broken.filter((k) => !critical.includes(k)),
    working,
  }
}

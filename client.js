/**
 * dsh-douyin-bridge —— 浏览器半端（**设置在「设置」里的一页**）
 * ============================================================================
 * ⭐ **client bundle 不是 ESM，是自注册脚本**（DSH 的约定）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                       // 必须等于 package.json 的 name
 *       factory: (require) => {
 *         const React = require('react')
 *         return { inject: ['slots'], apply(ctx) { ... } }
 *       },
 *     })
 *
 * ⭐ **进「设置」**：
 *
 *     const slots = ctx.get('slots')
 *     slots.inject('settings.section', () => slots.register(
 *       { name: 'settings.section', id: 'douyin-bridge', order: 31, label: '刷抖音' },
 *       () => h(Panel),
 *     ))
 *
 * 这一页要能回答使用者最关心的四件事：
 *   1. 现在在跑吗？上次轮询是什么时候？有没有报错？
 *   2. 抖音登录了没有？（没登录就一个按钮把他领到浏览器那边）
 *   3. 谁的消息会进 DSH？（白名单）
 *   4. AI 回了话会不会自动发回抖音？（模式）
 */
window.__ModuleLoader__.load({
  id: 'dsh-douyin-bridge',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/dsh-douyin-bridge'

    /** HTTP 错误要看得见，不能把 500 当成「已保存」 */
    const asJson = async (res) => {
      const text = await res.text()
      let body = {}
      try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
      if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status))
      if (body && body.ok === false) throw new Error(body.error || '操作失败')
      return body
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-dy-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 8px;max-width:640px;}
[data-dy-sec]{display:flex;flex-direction:column;gap:8px;}
[data-dy-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-dy-label]{font-size:13px;}
[data-dy-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dy-val]{font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
[data-dy-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.15));color:inherit;}
[data-dy-btn]{font-size:12px;padding:6px 12px;border-radius:8px;cursor:pointer;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.16));
  background:var(--dsw-alias-interactive-bg,rgba(128,128,128,.18));color:inherit;}
[data-dy-btn:hover]{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.3));}
[data-dy-btn[disabled]{opacity:.45;cursor:default;}
[data-dy-sel]{font-size:12px;padding:6px 8px;border-radius:8px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.15));color:inherit;}
[data-dy-log]{font-size:11px;line-height:17px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  white-space:pre-wrap;word-break:break-all;max-height:260px;overflow:auto;
  padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.18));}
[data-dy-pill]{font-size:11px;padding:2px 8px;border-radius:999px;
  background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.1));}
[data-dy-ok]{color:#4ade80;}[data-dy-bad]{color:#f87171;}[data-dy-warn]{color:#fbbf24;}
`

    function Row(props) {
      return h('div', { 'data-dy-row': '' }, props.children)
    }
    function Sec(props) {
      return h('div', { 'data-dy-sec': '' },
        h('div', { 'data-dy-h': '' }, props.title),
        props.children)
    }

    function Panel() {
      const [status, setStatus] = useState(null)
      const [cfg, setCfg] = useState(null)
      const [log, setLog] = useState([])
      const [msg, setMsg] = useState('')
      const [busy, setBusy] = useState(false)
      const [peersText, setPeersText] = useState('')

      const refresh = useCallback(async () => {
        try {
          const s = await jget('/status')
          setStatus(s.status || null)
          setCfg(s.config || null)
          setPeersText((s.config?.peers || []).join(', '))
          const l = await jget('/log')
          setLog(l.log || [])
        } catch (e) {
          setMsg(String(e.message || e))
        }
      }, [])

      useEffect(() => {
        refresh()
        const t = setInterval(refresh, 4000)
        return () => clearInterval(t)
      }, [refresh])

      const act = async (path, body) => {
        setBusy(true)
        setMsg('')
        try {
          const r = await jpost(path, body)
          setMsg('好了')
          await refresh()
          return r
        } catch (e) {
          setMsg(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const savePeers = async () => {
        const peers = peersText.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
        await act('/config', { peers })
      }

      const running = status?.running
      const last = status?.lastPollAt
        ? new Date(status.lastPollAt).toLocaleTimeString()
        : '还没跑过'

      return h('div', { 'data-dy-page': '' },
        h('div', { 'data-dy-note': '' },
          '抖音私信会进 DSH 会话；AI 通过 douyin_* 工具刷视频、分享、回话。'
          + '所有对话内容都存在 DSH 里，本插件只留「谁对应哪个会话」和去重指纹。'),

        h(Sec, { title: '状态' },
          h(Row, null,
            h('span', { 'data-dy-pill': '' }, running ? '桥接运行中' : '桥接已停'),
            h('span', { 'data-dy-label': '' }, '模式：'),
            h('span', { 'data-dy-val': '' }, status?.mode || '—'),
            h('span', { 'data-dy-label': '' }, '上次轮询：'),
            h('span', { 'data-dy-val': '' }, last),
          ),
          h(Row, null,
            h('span', { 'data-dy-label': '' }, '已注入：'),
            h('span', { 'data-dy-val': '' }, String(status?.injected ?? 0)),
            h('span', { 'data-dy-label': '' }, '已回发：'),
            h('span', { 'data-dy-val': '' }, String(status?.sent ?? 0)),
            h('span', { 'data-dy-label': '' }, '浏览器：'),
            h('span', {
              'data-dy-val': '',
              'data-dy-ok': status?.browserReady ? '' : undefined,
              'data-dy-warn': status?.browserReady ? undefined : '',
            }, status?.browserReady ? '已就绪' : '未启动'),
          ),
          status?.lastError
            ? h('div', { 'data-dy-note': '', 'data-dy-bad': '' }, '最近错误：' + status.lastError)
            : null,
          h(Row, null,
            h('button', {
              'data-dy-btn': '', disabled: busy,
              onClick: () => act('/login'),
            }, '打开浏览器登录'),
            h('button', {
              'data-dy-btn': '', disabled: busy,
              onClick: () => act('/poll'),
            }, '立刻轮询一次'),
            running
              ? h('button', { 'data-dy-btn': '', disabled: busy, onClick: () => act('/stop') }, '停止轮询')
              : h('button', { 'data-dy-btn': '', disabled: busy, onClick: () => act('/start') }, '开始轮询'),
            h('button', { 'data-dy-btn': '', disabled: busy, onClick: refresh }, '刷新'),
          ),
          msg ? h('div', { 'data-dy-note': '' }, msg) : null),

        h(Sec, { title: '谁的消息会进 DSH' },
          h(Row, null,
            h('span', { 'data-dy-label': '' }, '好友白名单（逗号分隔，留空 = 全部）'),
          ),
          h('input', {
            'data-dy-input': '', value: peersText,
            placeholder: '例：好友A, 好友B',
            onChange: (e) => setPeersText(e.target.value),
          }),
          h(Row, null,
            h('button', { 'data-dy-btn': '', disabled: busy, onClick: savePeers }, '保存白名单'),
            h('span', { 'data-dy-note': '' }, '留空 = 所有会话都会进（自己发的消息永不回灌）'),
          )),

        h(Sec, { title: 'AI 回了话怎么办' },
          h('div', { 'data-dy-note': '' },
            'simulation（默认）：AI 自己决定要不要回、用 douyin_dm_send 发出去。'
            + 'mirror：AI 的每条回复都自动发回抖音。off：只提供工具，不做任何自动注入。'),
          h(Row, null,
            h('select', {
              'data-dy-sel': '',
              value: cfg?.mode || 'simulation',
              onChange: (e) => act('/config', { mode: e.target.value }),
            },
              h('option', { value: 'simulation' }, 'simulation — AI 自己决定'),
              h('option', { value: 'mirror' }, 'mirror — 自动回发'),
              h('option', { value: 'off' }, 'off — 只给工具'),
            ),
          )),

        h(Sec, { title: '日志' },
          h('div', { 'data-dy-log': '' }, (log || []).join('\n') || '（还没有日志）')),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-douyin-bridge')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-douyin-bridge: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'douyin-bridge', order: 31, label: '刷抖音' },
          () => h(Panel),
        ))
      },
    }
  },
})

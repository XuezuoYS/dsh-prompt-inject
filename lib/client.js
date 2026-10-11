/**
 * dsh-prompt-inject 的浏览器半（手写 bundle，不走构建链）。
 *
 * 形态与官方客户端包一致：`window.__ModuleLoader__.load({ id, factory })`，
 * factory 只注册一个懒工厂，真正的逻辑走 `apply(ctx)` 与官方的槽位系统。
 *
 * 页面：设置导航里独立一项，按「注入点 → 规则列表」编辑，500ms debounce 自动保存。
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-inject',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    //#region 注入点表（与 lib/injectPoints.js 保持一致）
    /**
     * 注入点顺序即页面顺序。
     * `kind` 决定它怎么进 system：`anchor`=插进某个段位、`replace`=改写官方已有那一段。
     */
    const INJECT_POINTS = [
      {
        key: 'user.prefix',
        label: '用户前置词',
        group: 'user',
        hint: '插在当前用户输入之前，每轮只注入一次。',
        notice: '注意：注入后不会自动清除。这段文字会一直留在会话历史里，和用户原文一样是 user 消息，之后每一轮都还能被模型读到。',
      },
      {
        key: 'user.suffix',
        label: '用户后置词',
        group: 'user',
        hint: '插在当前用户输入之后，每轮只注入一次。',
        notice: '注意：注入后不会自动清除。它会留在历史里，并紧跟在用户原文之后——下一轮可能被模型当成「用户又补充的一句」来读，请只写不会引起误解的内容。',
      },
      { key: 'system.personaHead', label: 'system 头部', group: 'system', kind: 'replace', anchor: '替换官方 persona 头', hint: '改写官方 persona 段的头（官方用于告知模型当前调用的模型名）；不配就保持官方默认。' },
      { key: 'system.beforeTools', label: '工具说明之前', group: 'system', kind: 'anchor', anchor: 'order 950' },
      { key: 'system.afterTools', label: '工具说明之后', group: 'system', kind: 'anchor', anchor: 'order 3050' },
      { key: 'system.middle', label: '结构化输出之前', group: 'system', kind: 'anchor', anchor: 'order 9800' },
      { key: 'system.personaTail', label: 'system 尾部', group: 'system', kind: 'replace', anchor: '替换官方 persona 尾', hint: '改写官方 persona 段的尾（官方用于告知当前工作目录位置）；不配就保持官方默认。' },
      { key: 'system.last', label: 'system 最末尾', group: 'system', kind: 'anchor', anchor: 'order 10300', hint: '排在官方 persona 尾之后。' },
    ]

    /** 分组标题，按顺序渲染。 */
    const GROUPS = [
      { id: 'user', title: '用户消息', hint: '插在用户输入前后，各自是一条独立的 user 消息；注入后不会自动清除。' },
      { id: 'system', title: 'system 段（按在 system 里出现的先后排列）', hint: '「替换」= 改写官方已有的那一段；「插进」= 在指定段位新加一段。' },
    ]
    //#endregion

    //#region 小工具
    /** 生成规则 id（页面内唯一即可）。 */
    function newRuleId() {
      return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    }

    /** 深拷贝（配置就是纯 JSON）。 */
    function clone(value) {
      return value === undefined ? value : JSON.parse(JSON.stringify(value))
    }

    /** 空规则。 */
    function emptyRule() {
      return { id: newRuleId(), enabled: true, text: '', models: { all: true, list: [] } }
    }

    /** 已知的注入点键。 */
    function knownPointKeys() {
      return new Set(INJECT_POINTS.map((point) => point.key))
    }

    /**
     * 只留下本版本认识的注入点键。
     * 旧版客户端留下的键（例如 `system.persona`）不能原样回传，否则会被服务端当成非法内容。
     * @param {object} slots - 任意 slots。
     * @returns {object} 干净的 slots（每个键都是 `{ rules: [...] }`）。
     */
    function sanitizeSlots(slots) {
      const clean = {}
      for (const point of INJECT_POINTS) {
        const rules = slots?.[point.key]?.rules
        clean[point.key] = { rules: Array.isArray(rules) ? rules : [] }
      }
      return clean
    }

    /**
     * 造一整份空的 slots（读不到服务端配置时的兜底）。
     * @returns {object} slots。
     */
    function emptySlots() {
      return sanitizeSlots({})
    }

    /**
     * 读一个注入点的规则列表。
     * @param {object} slots - slots。
     * @param {string} pointKey - 注入点键。
     * @returns {Array<object>} 规则列表。
     */
    function rulesAt(slots, pointKey) {
      const rules = slots?.[pointKey]?.rules
      return Array.isArray(rules) ? rules : []
    }

    /**
     * 写一个注入点的规则列表，返回新的 slots（不改原对象）。
     * @param {object} slots - 原 slots。
     * @param {string} pointKey - 注入点键。
     * @param {Array<object>} rules - 新的规则列表。
     * @returns {object} 新的 slots。
     */
    function withRules(slots, pointKey, rules) {
      const next = clone(slots ?? {})
      if (next[pointKey] === undefined || typeof next[pointKey] !== 'object' || Array.isArray(next[pointKey])) next[pointKey] = {}
      next[pointKey].rules = rules
      return next
    }

    /** 一条规则的模型键列表。 */
    function modelKeysOf(rule) {
      return Array.isArray(rule?.models?.list) ? rule.models.list : []
    }

    /** 规则是否完全不生效（没勾全部也没勾模型，或没文本）。 */
    function ruleInactive(rule) {
      if (typeof rule?.text !== 'string' || rule.text === '') return true
      if (rule?.models?.all === true) return false
      return modelKeysOf(rule).length === 0
    }

    /**
     * 规则文本里引用了、但字段表里没有的模板字段（按出现顺序、去重）。
     * 名字不符合官方规则的组（比如写中文）不算「拼错」——那本来就是字面花括号，不给提示。
     *
     * @param {string} text - 规则文本。
     * @param {Array<{ name: string }>} fields - 可用的模板字段。
     * @returns {string[]} 拼错/不认识的名字。
     */
    function unknownTemplateFields(text, fields) {
      if (typeof text !== 'string' || text.indexOf('{{') === -1) return []
      const known = new Set((fields ?? []).map((field) => field.name))
      const found = []
      const pattern = /\{\{([^{}]*)\}\}/g
      for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
        const name = match[1]
        if (/^[a-z][a-z0-9_]*$/.test(name) && !known.has(name) && !found.includes(name)) found.push(name)
      }
      return found
    }

    /**
     * 把一段文本插进光标处（没有光标信息就插到末尾，光标区间越界就退化成插入点）。
     *
     * @param {string} text - 原文本。
     * @param {string} token - 要插入的文本。
     * @param {number} [start] - 选区起点。
     * @param {number} [end] - 选区终点。
     * @returns {string} 新文本。
     */
    function insertAtCaret(text, token, start, end) {
      const source = typeof text === 'string' ? text : ''
      const from = Number.isInteger(start) && start >= 0 && start <= source.length ? start : source.length
      const to = Number.isInteger(end) && end >= from && end <= source.length ? end : from
      return `${source.slice(0, from)}${token}${source.slice(to)}`
    }
    //#endregion

    //#region 数据控制器：拉状态、乐观写、debounce、409 回滚
    /** 连服务端的状态控制器。 */
    class Controller {
      /** @param {string} api - 端点前缀。 */
      constructor(api) {
        this.api = api
        this.listeners = new Set()
        this.timer = undefined
        this.loading = false
        this.snapshot = {
          status: 'loading',
          message: '正在读取配置…',
          revision: undefined,
          slots: emptySlots(),
          fields: [],
          catalog: { providers: [], degraded: false },
          /**
           * 每个折叠小节的显式状态：`undefined` = 跟随默认（有规则就展开），
           * `true` / `false` = 用户手动开/关过，以用户为准。
           * 之前只有「开着的那个键」一个值，于是有规则的注入点永远收不起来。
           */
          panels: {},
          openModelRule: undefined,
          toast: undefined,
        }
      }

      /** 订阅（给 useRules 用）。 */
      subscribe = (listener) => {
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      }

      /** 取当前快照。 */
      getSnapshot = () => this.snapshot

      /** 发布新快照。 */
      publish(patch) {
        this.snapshot = { ...this.snapshot, ...patch }
        for (const listener of this.listeners) listener()
      }

      /** 首次加载。 */
      async load() {
        this.loading = true
        try {
          const response = await fetch(`${this.api}/state`)
          const body = await response.json()
          if (!response.ok) throw new Error(body?.message ?? `HTTP ${response.status}`)
          this.publish({
            status: 'saved',
            message: '已保存',
            revision: body.revision,
            slots: sanitizeSlots(body.slots),
            fields: Array.isArray(body.fields) ? body.fields : [],
            catalog: body.catalog ?? { providers: [], degraded: false },
          })
        } catch (error) {
          this.publish({ status: 'failed', message: `读取失败：${String(error?.message ?? error)}` })
        } finally {
          this.loading = false
        }
      }

      /**
       * 改一个注入点的规则列表，乐观更新 + debounce 保存。
       * @param {string} pointKey - 注入点键。
       * @param {(rules: Array<object>) => Array<object>} change - 变更函数。
       */
      edit(pointKey, change) {
        const current = rulesAt(this.snapshot.slots, pointKey)
        const rules = change(current.map((rule) => clone(rule)))
        this.publish({
          slots: withRules(this.snapshot.slots, pointKey, rules),
          status: 'pending',
          message: '保存中…',
        })
        this.schedule()
      }

      /** 安排一次 debounce 保存。 */
      schedule() {
        if (this.timer !== undefined) clearTimeout(this.timer)
        this.timer = setTimeout(() => {
          this.timer = undefined
          void this.save()
        }, 500)
      }

      /** 真正提交。 */
      async save() {
        const revision = this.snapshot.revision
        const slots = sanitizeSlots(this.snapshot.slots)
        try {
          const response = await fetch(`${this.api}/rules`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ revision, slots }),
          })
          const body = await response.json().catch(() => undefined)
          if (response.status === 409) {
            this.publish({
              revision: body?.revision,
              slots: sanitizeSlots(body?.slots ?? this.snapshot.slots),
              status: 'failed',
              message: '配置已被其它窗口改过，已载入最新值',
            })
            return
          }
          if (!response.ok) {
            const detail = body?.issues?.map((item) => `${item.path} ${item.message}`).join('；')
            this.publish({ status: 'failed', message: detail === undefined || detail === '' ? `保存失败（HTTP ${response.status}）` : `保存失败：${detail}` })
            return
          }
          const ignored = Array.isArray(body.dropped) && body.dropped.length > 0 ? `（已忽略旧版本的字段：${body.dropped.join('、')}）` : ''
          this.publish({ revision: body.revision, slots: sanitizeSlots(body.slots ?? slots), status: 'saved', message: `已保存${ignored}` })
        } catch (error) {
          this.publish({ status: 'failed', message: `保存失败：${String(error?.message ?? error)}` })
        }
      }

      /**
       * 开/关模型多选弹层。
       * @param {string | undefined} pointKey - 注入点键。
       * @param {string | undefined} ruleId - 规则 id。
       */
      setOpenModelRule(pointKey, ruleId) {
        this.publish({ openModelRule: ruleId === undefined ? undefined : { pointKey, ruleId } })
      }

      /**
       * 删掉一条规则，并给一次撤销机会。
       * @param {string} pointKey - 注入点键。
       * @param {object} rule - 被删掉的规则（已深拷贝）。
       * @param {number} at - 它原来的位置。
       */
      removeRule(pointKey, rule, at) {
        this.edit(pointKey, (list) => list.filter((item) => item.id !== rule.id))
        this.publish({
          toast: {
            text: '已删除 1 条规则',
            undo: () => {
              this.clearToast()
              this.restoreRule(pointKey, rule, at)
            },
          },
        })
      }

      /**
       * 把规则放回原来的位置（找不到原位置就放回末尾）。
       * @param {string} pointKey - 注入点键。
       * @param {object} rule - 要放回的规则。
       * @param {number} at - 原来的位置。
       */
      restoreRule(pointKey, rule, at) {
        this.edit(pointKey, (list) => {
          if (list.some((item) => item.id === rule.id)) return list
          const next = [...list]
          next.splice(Math.max(0, Math.min(at, next.length)), 0, rule)
          return next
        })
        this.publish({ toast: { text: '已恢复那条规则' } })
      }

      /**
       * 开/关一个折叠小节。
       *
       * 状态由控制器自己算，不依赖视图把「当前是否展开」传进来：注入面是逐个方法包一层转发，
       * 多传的参数会被丢掉（上一版就是因此永远只往「展开」翻，关不上）。
       *
       * @param {string} pointKey - 注入点键。
       */
      togglePanel(pointKey) {
        const panels = this.snapshot.panels ?? {}
        const explicit = panels[pointKey]
        // 没手动开/关过时的默认：有规则就展开。用户点一次之后就以用户为准。
        // 注意用**当前**快照里的规则：首次加载完成前 slots 还是空的，不能因此把有规则的小节判成收起。
        const current = typeof explicit === 'boolean' ? explicit : rulesAt(this.snapshot.slots, pointKey).length > 0
        this.publish({ panels: { ...panels, [pointKey]: !current } })
      }

      /** 关掉 toast。 */
      clearToast() {
        this.publish({ toast: undefined })
      }
    }
    //#endregion

    //#region 样式（只用 --dsw-* 设计变量，跟随主题；动效克制，尊重 prefers-reduced-motion）
    const CSS = `
.dshpi-root{display:flex;flex-direction:column;gap:12px;padding:4px 2px 32px;font-size:14px;color:var(--dsw-alias-label-primary)}
.dshpi-bar{display:flex;align-items:center;justify-content:flex-end;gap:12px;flex-wrap:wrap;padding:8px 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.dshpi-muted{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshpi-dimmed{color:var(--dsw-alias-label-dimmed)}
.dshpi-status{display:flex;gap:6px;align-items:center;white-space:nowrap}
.dshpi-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:background 120ms ease}
.dshpi-dot[data-state="pending"]{background:var(--dsw-alias-state-business-primary);animation:dshpi-pulse 1.1s ease-in-out infinite}
.dshpi-dot[data-state="saved"]{background:var(--dsw-alias-state-success-primary,var(--dsw-alias-state-business-primary))}
.dshpi-dot[data-state="failed"]{background:var(--dsw-alias-state-error-primary,var(--dsw-alias-state-business-primary))}
@keyframes dshpi-pulse{0%,100%{opacity:1}50%{opacity:0.35}}

.dshpi-section{display:flex;flex-direction:column;gap:8px}
.dshpi-section-title{font-weight:600}
.dshpi-anchor{font-size:11px;line-height:17px;padding:1px 8px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dshpi-kind{font-size:11px;line-height:17px;padding:0 7px;border-radius:999px;white-space:nowrap;border:0.5px solid transparent}
.dshpi-kind[data-kind="replace"]{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent)}
.dshpi-kind[data-kind="anchor"]{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 35%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)}
.dshpi-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshpi-notice{margin-top:2px;padding:6px 9px;border-radius:var(--dsw-radius-md);border:0.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;white-space:normal;overflow-wrap:anywhere}
.dshpi-count{font-size:11px;line-height:17px;padding:0 7px;border-radius:999px;color:var(--dsw-alias-label-tertiary);background:color-mix(in srgb, var(--dsw-alias-label-tertiary) 12%, transparent)}

/* 模板字段提示条 */
.dshpi-fields{display:flex;flex-direction:column;gap:5px;padding:7px 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:color-mix(in srgb, var(--dsw-alias-label-tertiary) 6%, transparent)}
.dshpi-fields-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshpi-field-chip{cursor:pointer;font:inherit;font-size:12px;line-height:18px;padding:1px 8px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l4);background:transparent;color:var(--dsw-alias-label-secondary);transition:border-color 120ms ease,color 120ms ease}
.dshpi-field-chip:hover{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}
.dshpi-field-chip:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshpi-fields-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px;overflow-wrap:anywhere}
.dshpi-card-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:17px;overflow-wrap:anywhere}

/* 分组 */
.dshpi-group{display:flex;flex-direction:column;gap:8px}
.dshpi-group-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:0 2px}
.dshpi-group-title{font-size:12px;font-weight:600;letter-spacing:0.02em;color:var(--dsw-alias-label-secondary)}

/* 折叠小节 */
.dshpi-disclosure{display:flex;flex-direction:column;gap:8px;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);transition:border-color 120ms ease}
.dshpi-disclosure:hover{border-color:var(--dsw-alias-border-l2,var(--dsw-alias-border-l4))}
.dshpi-disclosure[data-open="false"]{background:transparent}
.dshpi-disclosure-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;width:100%;cursor:pointer;background:none;border:none;padding:2px 0;color:inherit;font:inherit;text-align:left;border-radius:var(--dsw-radius-md)}
.dshpi-disclosure-head:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshpi-chevron{display:inline-flex;align-items:center;color:var(--dsw-alias-label-tertiary);transition:transform 120ms ease}
.dshpi-disclosure-head:hover .dshpi-chevron{color:var(--dsw-alias-label-secondary)}

/* 规则卡片 */
.dshpi-card{display:flex;flex-direction:column;gap:8px;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);transition:border-color 120ms ease,box-shadow 120ms ease}
.dshpi-card:hover{border-color:var(--dsw-alias-border-l2,var(--dsw-alias-border-l4))}
.dshpi-card:focus-within{box-shadow:inset 2px 0 0 var(--dsw-alias-state-business-primary)}
.dshpi-card-head{display:flex;align-items:center;gap:8px;min-height:28px}
.dshpi-spacer{flex:1 1 auto;min-width:8px}
.dshpi-card-actions{display:flex;align-items:center;gap:2px;flex:0 0 auto}
.dshpi-divider{width:1px;height:16px;margin:0 4px;background:var(--dsw-alias-border-l4);flex:0 0 auto}

/* 模型作用域：一句话结论 + 整块可点 */
.dshpi-scope{display:inline-flex;align-items:center;gap:6px;max-width:46%;flex:0 1 auto;min-width:0;padding:1px 10px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l4);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;cursor:pointer;white-space:nowrap;overflow:hidden;transition:border-color 120ms ease,background 120ms ease,color 120ms ease}
.dshpi-scope:hover{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.dshpi-scope:active{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent)}
.dshpi-scope:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dshpi-scope:disabled{cursor:default;opacity:0.6}
.dshpi-scope[data-all="true"]{border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);color:var(--dsw-alias-state-business-primary)}
.dshpi-scope[data-all="true"]:hover{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)}
.dshpi-scope[data-inactive="true"]{border-style:dashed;color:var(--dsw-alias-label-tertiary)}
.dshpi-scope-label{overflow:hidden;text-overflow:ellipsis}
.dshpi-scope-invalid{color:var(--dsw-alias-state-warn-primary);font-size:11px;white-space:nowrap}

/* 正文：卡片唯一主体 */
.dshpi-textarea{width:100%;box-sizing:border-box;min-height:64px;resize:vertical;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font:inherit;line-height:20px;outline:none;transition:border-color 120ms ease,box-shadow 120ms ease}
.dshpi-textarea:hover{border-color:var(--dsw-alias-border-l2,var(--dsw-alias-border-l4))}
.dshpi-textarea:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)}
.dshpi-textarea::placeholder{color:var(--dsw-alias-label-dimmed)}

.dshpi-empty{display:flex;align-items:center;justify-content:center;padding:14px 10px;border:0.5px dashed var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-tertiary);font-size:12px}

/* 模型多选弹层 */
.dshpi-model-list{display:flex;flex-direction:column;gap:8px;max-height:46vh;overflow:auto;padding-right:4px}
.dshpi-model-group{display:flex;flex-direction:column;gap:4px}
.dshpi-model-group-title{display:flex;align-items:baseline;gap:8px;position:sticky;top:0;padding:2px 0;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1))}
.dshpi-model-row{display:flex;align-items:center;gap:8px;padding:2px 4px;border-radius:var(--dsw-radius-md)}
.dshpi-model-row:hover{background:color-mix(in srgb, var(--dsw-alias-label-tertiary) 10%, transparent)}
.dshpi-model-key{color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshpi-model-note{padding:2px 4px;color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:17px;overflow-wrap:anywhere}
.dshpi-invalid{color:var(--dsw-alias-label-dimmed);text-decoration:line-through}
.dshpi-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:60}

/* 「读取中」时的骨架感：整页轻微降透明，避免闪烁 */
.dshpi-root[data-busy="true"]{opacity:0.85}

@media (prefers-reduced-motion: reduce){
  .dshpi-dot[data-state="pending"]{animation:none}
  .dshpi-card,.dshpi-disclosure,.dshpi-scope,.dshpi-textarea,.dshpi-chevron,.dshpi-field-chip{transition:none}
}
`

    /** 插样式，返回清理函数。 */
    function insertStyles() {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-prompt-inject'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }
    //#endregion

    //#region 规则卡片与列表
    /**
     * 一条规则卡片。
     *
     * 头部只有一行：启用开关 · 模型结论（整块可点，直接开模型作用域）· 右侧一排图标动作
     * （上移 / 下移 / 复制 / 删除）。卡片不显示文本摘要（正文就在下面的输入框里）。
     *
     * @param {object} props - 见下。
     * @returns {object} React 元素。
     */
    function RuleCard(props) {
      const { rule, index, count, disabled, modelIndex, fields, onEdit, onMove, onRemove, onDuplicate, onEditModels, onFocusRule, registerArea } = props
      const keys = modelKeysOf(rule)
      const invalidCount = keys.filter((key) => !modelIndex.keys.has(key)).length
      const appliedCount = keys.length - invalidCount
      const isAll = rule.models?.all === true
      const unknown = unknownTemplateFields(rule.text, fields)
      /** 模型作用域的一句话结论；`all` 与「无」都不看具体键。 */
      const scopeText = isAll ? '全部' : appliedCount === 0 ? '无应用' : `已应用 ${appliedCount} 个模型`
      return jsxs('div', {
        className: 'dshpi-card',
        children: [
          jsxs('div', {
            className: 'dshpi-card-head',
            children: [
              jsx(primitives.Switch, {
                checked: rule.enabled === true,
                disabled,
                label: '启用这条规则',
                onChange: (next) => onEdit({ enabled: next }),
              }),
              jsxs('button', {
                type: 'button',
                className: 'dshpi-scope',
                'data-all': isAll ? 'true' : 'false',
                'data-inactive': ruleInactive(rule) ? 'true' : 'false',
                disabled,
                title: '点击配置模型作用域',
                'aria-label': `模型作用域：${scopeText}，点击配置`,
                onClick: onEditModels,
                children: [
                  jsx('span', { className: 'dshpi-scope-label', children: scopeText }),
                  invalidCount > 0 ? jsx('span', { className: 'dshpi-scope-invalid', children: `已失效 ${invalidCount}` }) : null,
                ],
              }),
              jsx('div', { className: 'dshpi-spacer' }),
              jsxs('div', {
                className: 'dshpi-card-actions',
                children: [
                  jsx(primitives.Button, {
                    size: 'sm',
                    variant: 'ghost',
                    disabled: disabled || index === 0,
                    title: '上移',
                    'aria-label': '上移这条规则',
                    icon: jsx(primitives.IconChevronUpOutlineRegular, { size: 16 }),
                    onClick: () => onMove(index, -1),
                  }),
                  jsx(primitives.Button, {
                    size: 'sm',
                    variant: 'ghost',
                    disabled: disabled || index === count - 1,
                    title: '下移',
                    'aria-label': '下移这条规则',
                    icon: jsx(primitives.IconChevronDownOutlineRegular, { size: 16 }),
                    onClick: () => onMove(index, 1),
                  }),
                  jsx('span', { className: 'dshpi-divider', 'aria-hidden': 'true' }),
                  jsx(primitives.Button, {
                    size: 'sm',
                    variant: 'ghost',
                    disabled,
                    title: '复制一条',
                    'aria-label': '复制这条规则',
                    icon: jsx(primitives.IconCopyOutlineRegular, { size: 16 }),
                    onClick: onDuplicate,
                  }),
                  jsx(primitives.Button, {
                    size: 'sm',
                    variant: 'ghost',
                    disabled,
                    title: '删除（可撤销）',
                    'aria-label': '删除这条规则',
                    icon: jsx(primitives.IconCloseOutlineRegular, { size: 16 }),
                    onClick: onRemove,
                  }),
                ],
              }),
            ],
          }),
          jsx('textarea', {
            className: 'dshpi-textarea',
            value: rule.text,
            disabled,
            placeholder: '这段文字会按顺序拼进该注入点',
            ref: (element) => registerArea(rule.id, element),
            onFocus: () => onFocusRule(rule.id),
            onChange: (event) => onEdit({ text: event.target.value }),
          }),
          unknown.length > 0
            ? jsx('div', {
                className: 'dshpi-card-warn',
                children: `提示：${unknown.map((name) => `{{${name}}}`).join('、')} 不是可用的模板字段，会原样保留。`,
              })
            : null,
          ruleInactive(rule) ? jsx('div', { className: 'dshpi-muted', children: '没有勾选「全部」也没有勾选任何模型，这条规则当前不生效。' }) : null,
        ],
      })
    }

    /**
     * 一个注入点的模板字段提示条：徽章点一下把 `{{字段}}` 插进输入框，下面一行是各字段的注释。
     *
     * @param {object} props - 见下。
     * @returns {object | null} React 元素；服务端没给字段表时不渲染。
     */
    function TemplateFieldsBar(props) {
      const { fields, onInsert } = props
      if (!Array.isArray(fields) || fields.length === 0) return null
      return jsxs('div', {
        className: 'dshpi-fields',
        children: [
          jsxs('div', {
            className: 'dshpi-fields-row',
            children: [
              jsx('span', { className: 'dshpi-muted', children: '模板字段：' }),
              ...fields.map((field) =>
                jsx(
                  'button',
                  {
                    type: 'button',
                    className: 'dshpi-field-chip',
                    title: `点一下把 {{${field.name}}} 插到光标处`,
                    'aria-label': `插入模板字段 ${field.name}`,
                    onClick: () => onInsert(`{{${field.name}}}`),
                    children: `{{${field.name}}} ${field.label}`,
                  },
                  field.name,
                ),
              ),
            ],
          }),
          jsx('div', {
            className: 'dshpi-fields-note',
            children: fields.map((field) => `{{${field.name}}} ${field.note}`).join('　·　'),
          }),
        ],
      })
    }

    /**
     * 一个注入点下的规则列表。
     * @param {object} props - 见下。
     * @returns {object} React 元素。
     */
    function RuleList(props) {
      const { pointKey, rules, disabled, modelIndex, fields, onEdit, onUndoRemove } = props
      const mutate = (change) => onEdit(pointKey, change)
      /** 每条规则的输入框；点字段徽章时按「最近聚焦的那条」插入。 */
      const areas = React.useRef({})
      const [activeId, setActiveId] = React.useState(undefined)
      /** 记下输入框元素（卸载时传 null，顺手删掉）。 */
      const registerArea = (ruleId, element) => {
        if (element === null || element === undefined) delete areas.current[ruleId]
        else areas.current[ruleId] = element
      }
      /**
       * 把 `{{字段}}` 插进输入框：优先最近聚焦的那条规则，其次最后一条；
       * 一条规则都没有就新增一条（内容就是那个字段）。
       */
      const insertToken = (token) => {
        const focused = areas.current[activeId] === undefined ? undefined : rules.find((item) => item.id === activeId)
        const rule = focused ?? (rules.length > 0 ? rules[rules.length - 1] : undefined)
        if (rule === undefined) {
          mutate((list) => [...list, { ...emptyRule(), text: token }])
          return
        }
        const area = areas.current[rule.id]
        const caret = typeof area?.selectionStart === 'number' ? area.selectionStart : undefined
        const selectionEnd = typeof area?.selectionEnd === 'number' ? area.selectionEnd : undefined
        mutate((list) => list.map((item) => (item.id === rule.id ? { ...item, text: insertAtCaret(item.text, token, caret, selectionEnd) } : item)))
        // 光标跟到插入的字段后面；textarea 是受控的，等这一帧提交完再摆。
        const at = (Number.isInteger(caret) ? caret : (typeof rule.text === 'string' ? rule.text.length : 0)) + token.length
        setTimeout(() => {
          const node = areas.current[rule.id]
          if (node === undefined || node === null) return
          node.focus?.()
          node.setSelectionRange?.(at, at)
        }, 0)
      }
      return jsxs('div', {
        className: 'dshpi-section',
        children: [
          jsx(TemplateFieldsBar, { fields, onInsert: insertToken }),
          rules.length === 0
            ? jsx('div', { className: 'dshpi-empty', children: '还没有规则。点「新增规则」写一条，按顺序拼进这个注入点。' })
            : rules.map((rule, index) =>
                jsx(
                  RuleCard,
                  {
                    key: rule.id,
                    rule,
                    index,
                    count: rules.length,
                    disabled,
                    modelIndex,
                    fields,
                    onFocusRule: setActiveId,
                    registerArea,
                    onEdit: (patch) => mutate((list) => list.map((item) => (item.id === rule.id ? { ...item, ...patch } : item))),
                    onMove: (from, delta) =>
                      mutate((list) => {
                        const to = from + delta
                        if (to < 0 || to >= list.length) return list
                        const next = [...list]
                        const [moved] = next.splice(from, 1)
                        next.splice(to, 0, moved)
                        return next
                      }),
                    onRemove: () => {
                      // 删掉之后在原来的位置留一个「撤销」入口（Toast 里点一下就长回来）。
                      const at = index
                      const removed = clone(rules[at])
                      mutate((list) => list.filter((item) => item.id !== removed.id))
                      if (typeof onUndoRemove === 'function') onUndoRemove(pointKey, removed, at)
                    },
                    onDuplicate: () =>
                      mutate((list) => {
                        const indexOf = list.findIndex((item) => item.id === rule.id)
                        const copy = { ...clone(list[indexOf]), id: newRuleId() }
                        return [...list.slice(0, indexOf + 1), copy, ...list.slice(indexOf + 1)]
                      }),
                    onEditModels: () => props.onEditModels(pointKey, rule.id),
                  },
                  rule.id,
                ),
              ),
          jsx(primitives.Button, {
            size: 'sm',
            variant: 'outline',
            disabled,
            onClick: () => mutate((list) => [...list, emptyRule()]),
            children: '+ 新增规则',
          }),
        ],
      })
    }
    //#endregion

    //#region 模型作用域弹层
    /**
     * 模型多选弹层。
     * @param {object} props - 见下。
     * @returns {object | null} React 元素。
     */
    function ModelScopeModal(props) {
      const { open, rule, modelIndex, disabled, onEdit, onClose } = props
      const [query, setQuery] = React.useState('')
      if (!open) return null
      const selected = new Set(modelKeysOf(rule))
      const all = rule?.models?.all === true
      const groups = modelIndex.providers
        .map((provider) => ({
          ...provider,
          models: query === ''
            ? provider.models
            : provider.models.filter((model) => `${provider.id}/${model.id}`.toLowerCase().includes(query.toLowerCase()) || model.name.toLowerCase().includes(query.toLowerCase())),
        }))
        .filter((provider) => provider.models.length > 0)
      const unknown = [...selected].filter((key) => !modelIndex.keys.has(key))
      const toggle = (key) => {
        const next = new Set(selected)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        onEdit({ models: { all, list: [...next] } })
      }
      return jsx(primitives.Modal, {
        open: true,
        title: '模型作用域',
        closeLabel: '关闭',
        description: '勾「全部」对所有模型生效（含以后新增的），并且不会清空其它勾选；取消「全部」后，之前勾的模型继续生效。',
        onClose,
        footer: jsx(primitives.Button, { variant: 'primary', onClick: onClose, children: '完成' }),
        children: jsxs('div', {
          className: 'dshpi-model-list',
          children: [
            // provider 目录没拉全时在列表最上面说一句：这解释了下面那些「已失效」是怎么来的。
            modelIndex.degraded
              ? jsx('div', { className: 'dshpi-model-note', children: '部分 provider 的模型目录拉取失败，未列出的模型会显示为「已失效」。' })
              : null,
            jsxs('div', {
              className: 'dshpi-model-row',
              children: [
                jsx(primitives.Checkbox, {
                  checked: all,
                  disabled,
                  label: '全部模型',
                  onChange: (next) => onEdit({ models: { all: next, list: modelKeysOf(rule) } }),
                }),
                jsx('span', { className: 'dshpi-muted', children: all ? '对所有模型生效' : '当前只对下列勾选的模型生效' }),
              ],
            }),
            jsx(primitives.Input, {
              placeholder: '搜索模型…',
              value: query,
              disabled,
              onChange: (event) => setQuery(event.target.value),
            }),
            unknown.length > 0
              ? jsxs('div', {
                  className: 'dshpi-model-group',
                  children: [
                    jsx('div', { className: 'dshpi-muted', children: '已失效（目录里找不到，取消勾选前不参与注入）' }),
                    ...unknown.map((key) =>
                      jsx(
                        'div',
                        {
                          className: 'dshpi-model-row',
                          children: jsx(primitives.Checkbox, {
                            checked: true,
                            disabled,
                            label: `${key}（已失效）`,
                            onChange: () => toggle(key),
                          }),
                        },
                        key,
                      ),
                    ),
                  ],
                })
              : null,
            ...groups.map((provider) =>
              jsxs(
                'div',
                {
                  className: 'dshpi-model-group',
                  children: [
                    jsx('div', { className: 'dshpi-section-title', children: provider.displayName ?? provider.id }),
                    ...provider.models.map((model) => {
                      const key = `${provider.id}/${model.id}`
                      return jsxs(
                        'div',
                        {
                          className: 'dshpi-model-row',
                          children: [
                            jsx(primitives.Checkbox, {
                              checked: selected.has(key),
                              disabled,
                              label: model.name ?? model.id,
                              onChange: () => toggle(key),
                            }),
                            jsx('span', { className: 'dshpi-model-key', children: key }),
                          ],
                        },
                        key,
                      )
                    }),
                  ],
                },
                provider.id,
              ),
            ),
          ],
        }),
      })
    }
    //#endregion

    //#region 页面
    /**
     * 一个注入点的可折叠小节。
     *
     * @param {object} props - 见下。
     * @returns {object} React 元素。
     */
    function PointSection(props) {
      const { point, rules, open, disabled, modelIndex, fields, onToggle, onEdit, onEditModels, onUndoRemove } = props
      return jsxs('div', {
        className: 'dshpi-disclosure',
        'data-open': open ? 'true' : 'false',
        children: [
          jsxs('button', {
            type: 'button',
            className: 'dshpi-disclosure-head',
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => onToggle(),
            children: [
              jsx('span', {
                className: 'dshpi-chevron',
                style: { transform: open ? 'rotate(90deg)' : 'none' },
                children: jsx(primitives.IconChevronRightOutlineRegular, { size: 16 }),
              }),
              jsx('span', { className: 'dshpi-section-title', children: point.label }),
              point.kind === undefined
                ? null
                : jsx('span', { className: 'dshpi-kind', 'data-kind': point.kind, children: point.kind === 'replace' ? '替换' : '插进' }),
              point.anchor === undefined ? null : jsx('span', { className: 'dshpi-anchor', children: point.anchor }),
              rules.length === 0
                ? jsx('span', { className: 'dshpi-muted', children: '还没有规则' })
                : jsx('span', { className: 'dshpi-count', children: `${rules.length} 条` }),
              point.hint === undefined ? null : jsx('span', { className: 'dshpi-hint', children: point.hint }),
            ],
          }),
          open
            ? jsxs(React.Fragment, {
                children: [
                  point.notice === undefined ? null : jsx('div', { className: 'dshpi-notice', children: point.notice }),
                  jsx(RuleList, {
                    pointKey: point.key,
                    rules,
                    disabled,
                    modelIndex,
                    fields,
                    onEdit,
                    onEditModels,
                    onUndoRemove,
                  }),
                ],
              })
            : null,
        ],
      })
    }

    /**
     * 设置页。
     * @param {object} props - 槽位给的 props（含 useRules 与 close）。
     * @returns {object} React 元素。
     */
    function SettingsView(props) {
      const state = props.useRules((snapshot) => snapshot)
      const { slots, catalog, status, message, panels, fields, openModelRule, toast } = state
      const disabled = false
      const modelIndex = React.useMemo(() => {
        const keys = new Set()
        for (const provider of catalog?.providers ?? []) for (const model of provider.models) keys.add(`${provider.id}/${model.id}`)
        return { keys, providers: catalog?.providers ?? [], degraded: catalog?.degraded === true }
      }, [catalog])

      /** 找开着的模型弹层对应的规则。 */
      const openRule = React.useMemo(() => {
        if (openModelRule === undefined) return undefined
        const list = rulesAt(slots, openModelRule.pointKey)
        return list.find((rule) => rule.id === openModelRule.ruleId)
      }, [openModelRule, slots])

      const editRule = (patch) => {
        if (openModelRule === undefined) return
        props.editRules(openModelRule.pointKey, (list) =>
          list.map((rule) => (rule.id === openModelRule.ruleId ? { ...rule, ...patch } : rule)),
        )
      }

      /** 删除后的撤销入口。 */
      const undoRemove = (pointKey, rule, at) => props.removeRule(pointKey, rule, at)

      return jsxs('div', {
        className: 'dshpi-root',
        children: [
          jsxs('div', {
            className: 'dshpi-bar',
            children: [
              jsxs('div', {
                className: 'dshpi-status',
                children: [
                  jsx('span', { className: 'dshpi-dot', 'data-state': status }),
                  jsx('span', { className: status === 'failed' ? 'dshpi-muted' : undefined, children: message }),
                ],
              }),
            ],
          }),
          ...GROUPS.map((group) =>
            jsxs(
              'div',
              {
                className: 'dshpi-group',
                children: [
                  jsxs('div', {
                    className: 'dshpi-group-head',
                    children: [
                      jsx('span', { className: 'dshpi-group-title', children: group.title }),
                      jsx('span', { className: 'dshpi-muted', children: group.hint }),
                    ],
                  }),
                  ...INJECT_POINTS.filter((point) => point.group === group.id).map((point) => {
                    const rules = rulesAt(slots, point.key)
                    const explicit = panels?.[point.key]
                    // 没手动开/关过时，有规则就展开；手动过就以用户为准（所以有规则也能收起来）。
                    const open = typeof explicit === 'boolean' ? explicit : rules.length > 0
                    return jsx(
                      PointSection,
                      {
                        point,
                        rules,
                        open,
                        disabled,
                        modelIndex,
                        fields,
                        onToggle: () => props.togglePanel(point.key),
                        onEdit: props.editRules,
                        onEditModels: props.openModelRule,
                        onUndoRemove: undoRemove,
                      },
                      point.key,
                    )
                  }),
                ],
              },
              group.id,
            ),
          ),
          jsx(ModelScopeModal, {
            open: openModelRule !== undefined && openRule !== undefined,
            rule: openRule ?? { models: { all: false, list: [] } },
            modelIndex,
            disabled,
            onEdit: editRule,
            onClose: () => props.openModelRule(undefined, undefined),
          }),
          toast === undefined
            ? null
            : jsx('div', {
                className: 'dshpi-toast',
                children: jsx(primitives.Toast, {
                  text: toast.text,
                  tone: toast.tone,
                  actions:
                    typeof toast.undo !== 'function'
                      ? undefined
                      : [
                          {
                            prefix: '，',
                            label: '撤销',
                            onClick: () => {
                              toast.undo()
                              props.clearToast()
                            },
                          },
                        ],
                  onDone: props.clearToast,
                }),
              }),
        ],
      })
    }
    //#endregion

    //#region 插件装配
    /** Cordis 服务依赖。 */
    const inject = ['slots']

    /** 端点前缀，与 host 半的 settingsApi 一致。 */
    const API = '/api/dsh-prompt-inject'

    /**
     * 挂载设置页。
     * @param {object} ctx - 浏览器插件上下文。
     * @returns {void}
     */
    function apply(ctx) {
      const controller = new Controller(API)
      ctx.effect(() => insertStyles(), 'dsh-prompt-inject: styles')
      ctx.effect(() => () => {
        if (controller.timer !== undefined) clearTimeout(controller.timer)
      }, 'dsh-prompt-inject: timers')
      void controller.load()
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'promptInject',
            order: 50,
            label: () => 'dsh-prompt-inject',
            inject: () => ({
              hooks: { rules: controller },
              editRules: (pointKey, change) => controller.edit(pointKey, change),
              openModelRule: (pointKey, ruleId) => controller.setOpenModelRule(pointKey, ruleId),
              removeRule: (pointKey, rule, at) => controller.removeRule(pointKey, rule, at),
              togglePanel: (pointKey) => controller.togglePanel(pointKey),
              clearToast: () => controller.clearToast(),
            }),
          },
          SettingsView,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

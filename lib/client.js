/**
 * dsh-prompt-inject 的浏览器半（手写 bundle，不走构建链）。
 *
 * 形态与官方客户端包一致：`window.__ModuleLoader__.load({ id, factory })`，
 * factory 只注册一个懒工厂，真正的逻辑走 `apply(ctx)` 与官方的槽位系统。
 *
 * 页面：设置导航里独立一项，按「组 → 8 个位置块」编辑，500ms debounce 自动保存。
 * 组从上到下的顺序就是同一个位置的拼合顺序；组/位置关闭或文本留空都会跳过。
 */
window.__ModuleLoader__.load({
  id: '@xuezuoys/dsh-prompt-inject',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    //#region 注入点表（与 lib/injectPoints.js 保持一致）
    /**
     * 注入点顺序即页面顺序，也是拼合时「最后一个非空位置」的判定顺序。
     * `kind` 决定它怎么进 system：`anchor`=插进某个段位、`replace`=改写官方已有那一段。
     */
    const INJECT_POINTS = [
      {
        key: 'user.prefix',
        label: '用户前置词',
        hint: '插在当前用户输入之前，每轮只注入一次。',
        notice: '注意：注入后不会自动清除。这段文字会一直留在会话历史里，和用户原文一样是 user 消息，之后每一轮都还能被模型读到。',
      },
      {
        key: 'user.suffix',
        label: '用户后置词',
        hint: '插在当前用户输入之后，每轮只注入一次。',
        notice: '注意：注入后不会自动清除。它会留在历史里，并紧跟在用户原文之后——下一轮可能被模型当成「用户又补充的一句」来读，请只写不会引起误解的内容。',
      },
      { key: 'system.personaHead', label: 'system 头部', kind: 'replace', anchor: '替换官方 persona 头', hint: '改写官方 persona 段的头（官方用于告知模型当前调用的模型名）；不配就保持官方默认。' },
      { key: 'system.beforeTools', label: '工具说明之前', kind: 'anchor', anchor: 'order 950' },
      { key: 'system.afterTools', label: '工具说明之后', kind: 'anchor', anchor: 'order 3050' },
      { key: 'system.middle', label: '结构化输出之前', kind: 'anchor', anchor: 'order 9800' },
      { key: 'system.personaTail', label: 'system 尾部', kind: 'replace', anchor: '替换官方 persona 尾', hint: '替换官方 persona 段的尾（0.2.1 起官方默认为空串）；不配就保持官方默认。' },
      { key: 'system.last', label: 'system 最末尾', kind: 'anchor', anchor: 'order 10300', hint: '排在官方 persona 尾之后。' },
    ]
    //#endregion

    //#region 小工具
    /** 生成组 id（页面内唯一即可）。 */
    function newGroupId() {
      return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    }

    /** 深拷贝（配置就是纯 JSON）。 */
    function clone(value) {
      return value === undefined ? value : JSON.parse(JSON.stringify(value))
    }

    /** 一个默认位置块：关、空。 */
    function emptyPosition() {
      return { enabled: false, text: '' }
    }

    /** 一份完整的位置表：8 个已知注入点各一个默认块。 */
    function emptyPositions() {
      const positions = {}
      for (const point of INJECT_POINTS) positions[point.key] = emptyPosition()
      return positions
    }

    /**
     * 规整一份 groups：补齐 8 个位置、丢掉未知位置键、name 非字符串兜底、id 缺失兜底。
     *
     * 读盘与提交前都过一遍，保证客户端手里与发出去的都是同一个形状。
     * 空数组保持空（零组是合法状态）。
     *
     * @param {unknown} groups - 任意 groups 值。
     * @returns {Array<object>} 干净的 groups。
     */
    function sanitizeGroups(groups) {
      if (!Array.isArray(groups)) return []
      const result = []
      const seen = new Set()
      for (let index = 0; index < groups.length; index += 1) {
        const source = groups[index]
        if (source === null || typeof source !== 'object' || Array.isArray(source)) continue
        let id = typeof source.id === 'string' && source.id !== '' ? source.id : `group-${index + 1}`
        if (seen.has(id)) id = `${id}-${index + 1}`
        while (seen.has(id)) id = `${id}-x`
        seen.add(id)
        const sourcePositions = source.positions !== null && typeof source.positions === 'object' && !Array.isArray(source.positions) ? source.positions : {}
        const positions = {}
        for (const point of INJECT_POINTS) {
          const block = sourcePositions[point.key]
          positions[point.key] = {
            enabled: block?.enabled === true,
            text: typeof block?.text === 'string' ? block.text : '',
          }
        }
        const sourceModels = source.models !== null && typeof source.models === 'object' && !Array.isArray(source.models) ? source.models : {}
        result.push({
          id,
          name: typeof source.name === 'string' ? source.name : `组 ${index + 1}`,
          enabled: source.enabled !== false,
          models: {
            all: sourceModels.all === true,
            list: Array.isArray(sourceModels.list) ? sourceModels.list.filter((key) => typeof key === 'string' && key !== '') : [],
          },
          positions,
        })
      }
      return result
    }

    /** 一个组勾选的模型键列表。 */
    function modelKeysOf(group) {
      return Array.isArray(group?.models?.list) ? group.models.list : []
    }

    /**
     * 组作用域的一句话结论：`全部` / `已应用 N 个模型` / `无应用`，失效的另数。
     *
     * @param {object} group - 组。
     * @param {{ keys: Set<string> }} modelIndex - 当前模型目录索引。
     * @returns {{ all: boolean, applied: number, invalid: number, scopeText: string }} 结论。
     */
    function groupScopeSummary(group, modelIndex) {
      const keys = modelKeysOf(group)
      const invalid = keys.filter((key) => !modelIndex.keys.has(key)).length
      const applied = keys.length - invalid
      const all = group?.models?.all === true
      return {
        all,
        applied,
        invalid,
        scopeText: all ? '全部' : applied === 0 ? '无应用' : `已应用 ${applied} 个模型`,
      }
    }

    /**
     * 位置文本里引用了、但字段表里没有的模板字段（按出现顺序、去重）。
     * 名字不符合官方规则的组（比如写中文）不算「拼错」——那本来就是字面花括号，不给提示。
     *
     * @param {string} text - 位置文本。
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

    /**
     * 新建组的默认名字：`组 N`（N 从「当前组数 + 1」起，跳过已被占用的同名）。
     *
     * @param {Array<object>} groups - 现有组。
     * @returns {string} 新组名。
     */
    function nextGroupName(groups) {
      const used = new Set((groups ?? []).map((group) => (typeof group?.name === 'string' ? group.name.trim() : '')))
      let index = (groups ?? []).length + 1
      while (used.has(`组 ${index}`)) index += 1
      return `组 ${index}`
    }
    //#endregion

    //#region 数据控制器：拉状态、乐观写、debounce、409 回滚
    /**
     * 「模型目录可能变了」的官方推送事件，与 host 半 `settingsApi.js` 的
     * `CATALOG_INVALIDATION_EVENTS` 逐字一致（那边清缓存，这边重拉）。
     */
    const CATALOG_INVALIDATION_EVENTS = [
      'llm/adapters-updated',
      'settings/document-updated',
      'credentials/record-updated',
      'credentials/reference-updated',
    ]

    /** 收到失效推送后合并多久再重拉：连改几个模型只发一次请求。 */
    const CATALOG_REFRESH_DELAY_MS = 150

    /** 「停止输入」的判定时间：最后一次编辑后 20 秒无输入自动保存。 */
    const SAVE_DEBOUNCE_MS = 20000

    /**
     * 连服务端的状态控制器。
     *
     * 契约摘要：快照里只放可序列化状态；`lastNames`（组 id → 最近一次保存成功的完整组名）
     * 是内部 Map，不进快照。保存前把空组名恢复成 lastNames 里的名字再 POST。
     *
     * 常用入口：
     * - load: 读 `/state`。
     * - addGroup / editGroup / editPosition / moveGroup: 本地乐观编辑 + 黄色等待状态。
     *   保存时机：停止输入 20 秒，或 blur（flushSave，由输入框 onBlur 触发）。
     * - toggleGroupPanel / toggleCollapseAll: 折叠状态（纯页面状态，不保存）。
     * - requestRemoveGroup / cancelRemoveGroup / confirmRemoveGroup: 二次确认删除。
     * - openGroupScope: 开/关组作用域弹层。
     */
    class Controller {
      /**
       * @param {string} api - 端点前缀。
       * @param {(message: string, error: unknown) => void} [onWarn] - 记日志回调。
       */
      constructor(api, onWarn = () => {}) {
        this.api = api
        this.onWarn = onWarn
        this.listeners = new Set()
        this.timer = undefined
        this.catalogTimer = undefined
        this.catalogLoading = false
        this.catalogAgain = false
        this.loading = false
        /** 是否有一个保存请求在飞；离散操作连点时用它串行化。 */
        this.saving = false
        /** 保存请求在飞时又来了新编辑：完成后补一次。 */
        this.saveAgain = false
        /** 组 id → 最近一次非空组名（保存前恢复空名字用），刻意不进快照。 */
        this.lastNames = new Map()
        this.snapshot = {
          status: 'loading',
          message: '正在读取配置…',
          revision: undefined,
          groups: [],
          fields: [],
          catalog: { providers: [], degraded: false },
          pendingRemoveGroupId: undefined,
          openGroupScope: undefined,
          /** 组折叠状态：`组 id → 是否折叠`。只记页面状态，不进保存 payload。 */
          collapsedGroups: {},
          toast: undefined,
        }
      }

      /** 订阅（给 useGroups 用）。 */
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

      /**
       * 用一组 groups 重建 lastNames：非空名照抄，空名用 `组 N` 兜底。
       *
       * 只在「加载 / 保存成功 / 409 回滚」时调用，记的是**已落盘或已确认**的完整组名；
       * 编辑过程中的逐字中间值不进来（见 editGroup 的说明）。
       *
       * @param {Array<object>} groups - 已规整的 groups。
       * @returns {void}
       */
      rebuildLastNames(groups) {
        this.lastNames.clear()
        groups.forEach((group, index) => {
          const name = typeof group?.name === 'string' && group.name.trim() !== '' ? group.name : `组 ${index + 1}`
          this.lastNames.set(group.id, name)
        })
      }

      /** 首次加载。 */
      async load() {
        this.loading = true
        try {
          const response = await fetch(`${this.api}/state`)
          const body = await response.json()
          if (!response.ok) throw new Error(body?.message ?? `HTTP ${response.status}`)
          const groups = sanitizeGroups(body.groups)
          this.rebuildLastNames(groups)
          this.publish({
            status: 'saved',
            message: '已保存',
            revision: body.revision,
            groups,
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
       * 收到「模型变了」的推送：合并一拍去重拉目录。
       *
       * 模型设置页改一下会连着推好几条（设置落盘 + 适配器重挂），没必要一条拉一次。
       */
      invalidateCatalog() {
        if (this.catalogTimer !== undefined) clearTimeout(this.catalogTimer)
        this.catalogTimer = setTimeout(() => {
          this.catalogTimer = undefined
          void this.refreshCatalog()
        }, CATALOG_REFRESH_DELAY_MS)
      }

      /**
       * 重拉模型目录。
       *
       * 只换 `catalog` 一个字段：组、revision、保存状态都不动。设置页是本地乐观更新的，
       * 用户可能正在打字、还没到 500ms 提交，整包重读会把那份编辑冲掉。
       * 拉失败就留着旧目录（下一次事件或下次打开页面还会再试），不打断用户手上的事。
       */
      async refreshCatalog() {
        if (this.catalogLoading) {
          this.catalogAgain = true
          return
        }
        this.catalogLoading = true
        try {
          const response = await fetch(`${this.api}/catalog`)
          const body = await response.json()
          if (!response.ok) throw new Error(body?.message ?? `HTTP ${response.status}`)
          this.publish({ catalog: { providers: body.providers ?? [], degraded: body.degraded === true } })
        } catch (error) {
          this.onWarn('refresh model catalog failed', error)
        } finally {
          this.catalogLoading = false
          if (this.catalogAgain) {
            this.catalogAgain = false
            void this.refreshCatalog()
          }
        }
      }

      /**
       * 新建一个组（零组时也能用），默认启用、全部模型、8 个位置全关。
       *
       * @default text = undefined
       * @param {string} [text] - 给了就顺手填进新组的 `user.prefix` 并打开它（模板字段下拉在零组时用）。
       * @returns {string} 新组 id（视图插完字段后用它聚焦）。
       */
      addGroup(text) {
        const name = nextGroupName(this.snapshot.groups)
        const group = {
          id: newGroupId(),
          name,
          enabled: true,
          models: { all: true, list: [] },
          positions: emptyPositions(),
        }
        if (typeof text === 'string' && text !== '') group.positions['user.prefix'] = { enabled: true, text }
        this.lastNames.set(group.id, name)
        this.markImmediate({ groups: [...this.snapshot.groups, group] })
        return group.id
      }

      /**
       * 改一个组：先深拷贝，再交给 `change`，返回的新组替换原组。
       *
       * 组名不在这里更新 `lastNames`：用户逐字删除时，中间值会一路变短（「默认组」→「默」），
       * 拿它当「上一个名字」就会在清空后只恢复最后一个字。`lastNames` 只在保存成功 /
       * 加载 / 新建组时更新，保存时恢复的一定是完整的旧名字。
       *
       * @param {string} groupId - 组 id。
       * @param {(group: object) => object} change - 变更函数。
       * @returns {void}
       */
      editGroup(groupId, change) {
        const index = this.snapshot.groups.findIndex((group) => group.id === groupId)
        if (index < 0) return
        const current = clone(this.snapshot.groups[index])
        const next = change(current)
        if (next === null || typeof next !== 'object' || Array.isArray(next)) return
        const groups = [...this.snapshot.groups]
        groups[index] = next
        this.markEdited({ groups })
      }

      /**
       * 开 / 关一个组：离散操作，立即保存（不进入等待状态）。
       * @param {string} groupId - 组 id。
       * @param {boolean} enabled - 新的开关值。
       * @returns {void}
       */
      setGroupEnabled(groupId, enabled) {
        const index = this.snapshot.groups.findIndex((group) => group.id === groupId)
        if (index < 0) return
        const groups = [...this.snapshot.groups]
        groups[index] = { ...groups[index], enabled: enabled === true }
        this.markImmediate({ groups })
      }

      /**
       * 设置一个组的模型作用域：离散操作，立即保存。
       * @param {string} groupId - 组 id。
       * @param {{ all?: boolean, list?: string[] }} models - 新的作用域。
       * @returns {void}
       */
      setGroupModels(groupId, models) {
        const index = this.snapshot.groups.findIndex((group) => group.id === groupId)
        if (index < 0) return
        const list = Array.isArray(models?.list) ? models.list.filter((key) => typeof key === 'string' && key !== '') : []
        const groups = [...this.snapshot.groups]
        groups[index] = { ...groups[index], models: { all: models?.all === true, list: [...new Set(list)] } }
        this.markImmediate({ groups })
      }

      /**
       * 开 / 关一个位置：离散操作，立即保存（不进入等待状态）。
       * @param {string} groupId - 组 id。
       * @param {string} pointKey - 注入点键。
       * @param {boolean} enabled - 新的开关值。
       * @returns {void}
       */
      setPositionEnabled(groupId, pointKey, enabled) {
        const index = this.snapshot.groups.findIndex((group) => group.id === groupId)
        if (index < 0) return
        const group = this.snapshot.groups[index]
        const current = group.positions?.[pointKey] ?? emptyPosition()
        const groups = [...this.snapshot.groups]
        groups[index] = { ...group, positions: { ...group.positions, [pointKey]: { ...current, enabled: enabled === true } } }
        this.markImmediate({ groups })
      }

      /**
       * 改一个位置块：`patch` 浅合并进该位置。
       *
       * 只用于文字输入 / 插入（走 20 秒等待）；开关请用 `setPositionEnabled`。
       *
       * @param {string} groupId - 组 id。
       * @param {string} pointKey - 注入点键。
       * @param {{ enabled?: boolean, text?: string }} patch - 要合入的字段。
       * @returns {void}
       */
      editPosition(groupId, pointKey, patch) {
        this.editGroup(groupId, (group) => {
          const current = group.positions?.[pointKey] ?? emptyPosition()
          return { ...group, positions: { ...group.positions, [pointKey]: { ...current, ...patch } } }
        })
      }

      /**
       * 上移 / 下移一个组：离散操作，立即保存。
       *
       * @param {string} groupId - 组 id。
       * @param {number} delta - -1 上移，1 下移。
       * @returns {void}
       */
      moveGroup(groupId, delta) {
        const groups = [...this.snapshot.groups]
        const from = groups.findIndex((group) => group.id === groupId)
        const to = from + delta
        if (from < 0 || to < 0 || to >= groups.length) return
        const [moved] = groups.splice(from, 1)
        groups.splice(to, 0, moved)
        this.markImmediate({ groups })
      }

      /**
       * 请求删除一个组：只开二次确认，不动数据。
       * @param {string} groupId - 组 id。
       * @returns {void}
       */
      requestRemoveGroup(groupId) {
        if (!this.snapshot.groups.some((group) => group.id === groupId)) return
        this.publish({ pendingRemoveGroupId: groupId })
      }

      /** 关掉删除确认。 */
      cancelRemoveGroup() {
        this.publish({ pendingRemoveGroupId: undefined })
      }

      /** 确认删除：真正从 groups 里去掉，立即保存，并给一条 Toast（不提供撤销）。 */
      confirmRemoveGroup() {
        const groupId = this.snapshot.pendingRemoveGroupId
        if (groupId === undefined) return
        const index = this.snapshot.groups.findIndex((group) => group.id === groupId)
        if (index < 0) {
          this.publish({ pendingRemoveGroupId: undefined })
          return
        }
        const group = this.snapshot.groups[index]
        const name = typeof group.name === 'string' && group.name.trim() !== '' ? group.name : (this.lastNames.get(groupId) ?? `组 ${index + 1}`)
        this.lastNames.delete(groupId)
        this.markImmediate({
          groups: this.snapshot.groups.filter((item) => item.id !== groupId),
          pendingRemoveGroupId: undefined,
          toast: { text: `已删除组「${name}」` },
        })
      }

      /**
       * 开/关组作用域弹层。
       * @param {string | undefined} groupId - 组 id；`undefined` 表示关闭。
       * @returns {void}
       */
      openGroupScope(groupId) {
        this.publish({ openGroupScope: groupId })
      }

      /**
       * 折叠 / 展开一个组：只记页面状态，不触发保存（不会写进 payload）。
       * @param {string} groupId - 组 id。
       * @returns {void}
       */
      toggleGroupPanel(groupId) {
        const collapsed = this.snapshot.collapsedGroups ?? {}
        const current = collapsed[groupId] === true
        this.publish({ collapsedGroups: { ...collapsed, [groupId]: !current } })
      }

      /**
       * 全部折叠 / 全部展开：还有展开的组就全部收起，否则全部展开。
       * 与单组折叠一样只记页面状态，不触发保存。
       * @returns {void}
       */
      toggleCollapseAll() {
        const groups = this.snapshot.groups
        const collapsed = this.snapshot.collapsedGroups ?? {}
        const anyOpen = groups.some((group) => collapsed[group.id] !== true)
        const next = {}
        if (anyOpen) {
          for (const group of groups) next[group.id] = true
        }
        this.publish({ collapsedGroups: next })
      }

      /** 关掉 toast。 */
      clearToast() {
        this.publish({ toast: undefined })
      }

      /**
       * 标记「有未保存的编辑」：发布数据补丁 + 黄色等待状态，并排一次 20s 自动保存。
       * @param {object} [patch] - 随这次编辑一起发布的数据（groups / toast 等）。
       * @returns {void}
       */
      markEdited(patch = {}) {
        this.publish({ ...patch, status: 'waiting', message: '等待编辑结束后保存' })
        this.schedule()
      }

      /**
       * 标记一次「离散操作」（开关 / 排序 / 增删组 / 作用域勾选）：数据一改就立即保存，
       * 不进入「等待编辑结束」状态。若此时还有文字编辑没保存，也一并提交。
       * @param {object} [patch] - 随这次操作一起发布的数据（groups / toast 等）。
       * @returns {void}
       */
      markImmediate(patch = {}) {
        this.publish({ ...patch, status: 'pending', message: '保存中…' })
        if (this.timer !== undefined) clearTimeout(this.timer)
        this.timer = undefined
        void this.save()
      }

      /** 安排一次「停止输入」自动保存（最后一次编辑后 20 秒）。 */
      schedule() {
        if (this.timer !== undefined) clearTimeout(this.timer)
        this.timer = setTimeout(() => {
          this.timer = undefined
          void this.save()
        }, SAVE_DEBOUNCE_MS)
      }

      /**
       * 用户取消聚焦（移开焦点）= 编辑结束：有待保存内容就立刻保存。
       * 没有待保存内容时不做事（不重复发请求）。
       * @returns {void}
       */
      flushSave() {
        if (this.timer === undefined) return
        clearTimeout(this.timer)
        this.timer = undefined
        void this.save()
      }

      /**
       * 保存前把空组名恢复成「最近一次保存成功的完整名字」，并先把恢复后的 groups 发布出去
       * （输入框立刻变回上一个名字），再提交。
       *
       * @returns {Array<object>} 恢复后的 groups。
       */
      restoreEmptyNames() {
        let changed = false
        const groups = this.snapshot.groups.map((group, index) => {
          const name = typeof group.name === 'string' ? group.name : ''
          if (name.trim() !== '') return group
          changed = true
          return { ...group, name: this.lastNames.get(group.id) ?? `组 ${index + 1}` }
        })
        if (changed) this.publish({ groups })
        return groups
      }

      /**
       * 真正提交（flush、20s 到点或离散操作触发）。
       *
       * 同一时刻只跑一个请求：离散操作连点时，后来的编辑记在 `saveAgain`，
       * 等当前请求成功后再补一次，避免两个请求拿同一个 revision 互相 409。
       */
      async save() {
        if (this.saving) {
          this.saveAgain = true
          return
        }
        this.saving = true
        const groups = sanitizeGroups(this.restoreEmptyNames())
        const revision = this.snapshot.revision
        this.publish({ status: 'pending', message: '保存中…' })
        let succeeded = false
        try {
          const response = await fetch(`${this.api}/rules`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ revision, groups }),
          })
          const body = await response.json().catch(() => undefined)
          if (response.status === 409) {
            const nextGroups = sanitizeGroups(body?.groups ?? this.snapshot.groups)
            this.rebuildLastNames(nextGroups)
            this.publish({
              revision: body?.revision,
              groups: nextGroups,
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
          const nextGroups = sanitizeGroups(body?.groups ?? groups)
          if (this.saveAgain) {
            // 这次请求在飞的时候又有新编辑：响应里的 groups 已经旧了。
            // 只同步 revision，保留本地最新 groups，finally 里会再补一次保存。
            this.publish({ revision: body.revision, status: 'pending', message: '保存中…' })
          } else {
            this.rebuildLastNames(nextGroups)
            const ignored = Array.isArray(body.dropped) && body.dropped.length > 0 ? `（已忽略旧版本的字段：${body.dropped.join('、')}）` : ''
            this.publish({ revision: body.revision, groups: nextGroups, status: 'saved', message: `已保存${ignored}` })
          }
          succeeded = true
        } catch (error) {
          this.publish({ status: 'failed', message: `保存失败：${String(error?.message ?? error)}` })
        } finally {
          this.saving = false
          if (succeeded && this.saveAgain) {
            this.saveAgain = false
            void this.save()
          } else if (!succeeded) {
            this.saveAgain = false
          }
        }
      }
    }
    //#endregion

    //#region 样式（只用 --dsw-* 设计变量，跟随主题；动效克制，尊重 prefers-reduced-motion）
    const CSS = `
.dshpi-root{display:flex;flex-direction:column;gap:12px;padding:4px 2px 32px;font-size:14px;color:var(--dsw-alias-label-primary)}
/* 顶栏悬浮：滚过页面时照常可见（sticky 保持在流内首位，内容天然避让它）。 */
.dshpi-bar{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;gap:8px 12px;flex-wrap:wrap;padding:8px 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.dshpi-bar-note{flex:1 1 100%;padding-top:6px;border-top:0.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px;overflow-wrap:anywhere}
.dshpi-muted{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshpi-dimmed{color:var(--dsw-alias-label-dimmed)}
.dshpi-status{display:flex;gap:6px;align-items:center;white-space:nowrap}
.dshpi-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:background 120ms ease}
.dshpi-dot[data-state="pending"]{background:var(--dsw-alias-state-business-primary);animation:dshpi-pulse 1.1s ease-in-out infinite}
.dshpi-dot[data-state="waiting"]{background:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-business-primary))}
.dshpi-waiting-text{color:var(--dsw-alias-state-warn-primary)}
.dshpi-dot[data-state="saved"]{background:var(--dsw-alias-state-success-primary,var(--dsw-alias-state-business-primary))}
.dshpi-dot[data-state="failed"]{background:var(--dsw-alias-state-error-primary,var(--dsw-alias-state-business-primary))}
@keyframes dshpi-pulse{0%,100%{opacity:1}50%{opacity:0.35}}

.dshpi-anchor{font-size:11px;line-height:17px;padding:1px 8px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dshpi-kind{font-size:11px;line-height:17px;padding:0 7px;border-radius:999px;white-space:nowrap;border:0.5px solid transparent}
.dshpi-kind[data-kind="replace"]{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent)}
.dshpi-kind[data-kind="anchor"]{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 35%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent)}
.dshpi-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshpi-notice{margin-top:2px;padding:6px 9px;border-radius:var(--dsw-radius-md);border:0.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;white-space:normal;overflow-wrap:anywhere}
.dshpi-count{font-size:11px;line-height:17px;padding:0 7px;border-radius:999px;color:var(--dsw-alias-label-tertiary);background:color-mix(in srgb, var(--dsw-alias-label-tertiary) 12%, transparent);white-space:nowrap}
.dshpi-divider{width:1px;height:16px;margin:0 4px;background:var(--dsw-alias-border-l4);flex:0 0 auto}

/* 模板字段下拉菜单（顶栏左侧）：点字段把 {{字段}} 插进最近编辑的位置，注释一并列出。 */
.dshpi-fieldmenu{position:relative}
.dshpi-fieldmenu-trigger{display:inline-flex;align-items:center;gap:6px;cursor:pointer;font:inherit;font-size:12px;line-height:20px;padding:2px 10px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l4);background:transparent;color:var(--dsw-alias-label-secondary);transition:border-color 120ms ease,color 120ms ease}
.dshpi-fieldmenu-trigger:hover{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}
.dshpi-fieldmenu-trigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshpi-fieldmenu-trigger[data-open="true"]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.dshpi-fieldmenu-caret{display:inline-flex;align-items:center;transition:transform 120ms ease}
.dshpi-fieldmenu-trigger[data-open="true"] .dshpi-fieldmenu-caret{transform:rotate(180deg)}
.dshpi-fieldmenu-pop{position:absolute;top:calc(100% + 6px);left:0;z-index:30;display:flex;flex-direction:column;gap:2px;min-width:280px;max-width:min(90vw,420px);max-height:60vh;overflow:auto;padding:6px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 24px color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent)}
.dshpi-fieldmenu-item{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;text-align:left;cursor:pointer;font:inherit;color:var(--dsw-alias-label-primary);transition:background 120ms ease}
.dshpi-fieldmenu-item:hover{background:color-mix(in srgb, var(--dsw-alias-label-tertiary) 10%, transparent)}
.dshpi-fieldmenu-item:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshpi-fieldmenu-name{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;flex-wrap:wrap}
.dshpi-fieldmenu-token{padding:0 6px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshpi-fieldmenu-label{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshpi-fieldmenu-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px;overflow-wrap:anywhere}
.dshpi-fieldmenu-hint{padding:4px 8px 2px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px;overflow-wrap:anywhere}
.dshpi-card-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:17px;overflow-wrap:anywhere}

/* 组卡片：整卡头部一行（开关 · 组名 · 作用域 · 顺序 · 动作），下面 8 个位置。 */
.dshpi-group-card{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);transition:border-color 120ms ease,box-shadow 120ms ease}
.dshpi-group-card:hover{border-color:var(--dsw-alias-border-l2,var(--dsw-alias-border-l4))}
.dshpi-group-card:focus-within{box-shadow:inset 2px 0 0 var(--dsw-alias-state-business-primary)}
.dshpi-group-card[data-off="true"]{background:transparent}
.dshpi-group-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:28px}
.dshpi-group-name{flex:1 1 160px;min-width:110px;max-width:260px}
.dshpi-group-name input{width:100%;box-sizing:border-box}
.dshpi-group-actions{display:flex;align-items:center;gap:2px;flex:0 0 auto;flex-wrap:nowrap}
.dshpi-group-note{padding:0 2px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px;overflow-wrap:anywhere}
.dshpi-order{font-size:11px;line-height:17px;padding:0 7px;border-radius:999px;color:var(--dsw-alias-label-tertiary);background:color-mix(in srgb, var(--dsw-alias-label-tertiary) 12%, transparent);white-space:nowrap}
.dshpi-off-tag{font-size:11px;line-height:17px;padding:0 7px;border-radius:999px;border:0.5px dashed var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary);white-space:nowrap}

/* 组折叠：头部左侧的小箭头；折叠后卡片只留头部一行，开关/组名/作用域/动作照常可用。 */
.dshpi-group-toggle{display:inline-flex;align-items:center;justify-content:center;padding:3px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:color 120ms ease}
.dshpi-group-toggle:hover{color:var(--dsw-alias-label-secondary)}
.dshpi-group-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshpi-chevron{display:inline-flex;align-items:center;transform:rotate(90deg);transition:transform 120ms ease}
.dshpi-group-card[data-open="false"] .dshpi-chevron{transform:none}
.dshpi-spacer{flex:1 1 auto;min-width:8px}

/* 位置行：关着只有一行，打开才出现输入框。 */
.dshpi-position{display:flex;flex-direction:column;gap:6px;padding:6px 8px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1));transition:border-color 120ms ease}
.dshpi-position:hover{border-color:var(--dsw-alias-border-l2,var(--dsw-alias-border-l4))}
.dshpi-position[data-open="false"]{background:transparent}
.dshpi-position-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:26px}
.dshpi-position-name{font-weight:500;white-space:nowrap}
.dshpi-position-body{display:flex;flex-direction:column;gap:6px}

/* 组作用域：一句话结论 + 整块可点 */
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

/* 正文：位置输入框 */
.dshpi-textarea{width:100%;box-sizing:border-box;min-height:64px;resize:vertical;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font:inherit;line-height:20px;outline:none;transition:border-color 120ms ease,box-shadow 120ms ease}
.dshpi-textarea:hover{border-color:var(--dsw-alias-border-l2,var(--dsw-alias-border-l4))}
.dshpi-textarea:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)}
.dshpi-textarea::placeholder{color:var(--dsw-alias-label-dimmed)}

/* 零组空状态：整块可点，点一下新建 组 1。 */
.dshpi-empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:28px 16px;border:0.5px dashed var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-secondary);cursor:pointer;text-align:center;transition:border-color 120ms ease,background 120ms ease}
.dshpi-empty-state:hover{border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 6%, transparent)}
.dshpi-empty-state:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshpi-empty-title{font-size:13px}
.dshpi-empty-cta{color:var(--dsw-alias-state-business-primary);font-size:13px;font-weight:500}
.dshpi-add-group{align-self:flex-start}

/* 模型多选弹层 */
.dshpi-model-list{display:flex;flex-direction:column;gap:8px;max-height:46vh;overflow:auto;padding-right:4px}
.dshpi-model-group{display:flex;flex-direction:column;gap:4px}
.dshpi-model-group-title{display:flex;align-items:baseline;gap:8px;position:sticky;top:0;padding:2px 0;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dshpi-model-row{display:flex;align-items:center;gap:8px;padding:2px 4px;border-radius:var(--dsw-radius-md)}
.dshpi-model-row:hover{background:color-mix(in srgb, var(--dsw-alias-label-tertiary) 10%, transparent)}
.dshpi-model-key{color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshpi-model-note{padding:2px 4px;color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:17px;overflow-wrap:anywhere}
.dshpi-invalid{color:var(--dsw-alias-label-dimmed);text-decoration:line-through}
.dshpi-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:60}

/* 「读取中」时的骨架感：整页轻微降透明，避免闪烁 */
.dshpi-root[data-busy="true"]{opacity:0.85}

@media (prefers-reduced-motion: reduce){
  .dshpi-dot[data-state="pending"]{animation:none}  .dshpi-group-card,.dshpi-position,.dshpi-scope,.dshpi-textarea,.dshpi-fieldmenu-trigger,.dshpi-fieldmenu-caret,.dshpi-fieldmenu-item,.dshpi-empty-state,.dshpi-group-toggle,.dshpi-chevron{transition:none}
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

    //#region 顶栏的模板字段下拉
    /**
     * 顶栏的「模板字段」下拉菜单：点字段把 `{{字段}}` 插进目标位置，字段注释逐项列出。
     *
     * 焦点契约（本组件存在的前提）：触发钮与菜单项都在 `mousedown` 上 `preventDefault`，
     * 打开菜单、点选字段全程不抢 textarea 的焦点，插入才能落在用户光标处。
     *
     * @param {object} props - 见下。
     * @returns {object | null} React 元素；服务端没给字段表时不渲染。
     */
    function TemplateFieldsMenu(props) {
      const { fields, onInsert } = props
      const [open, setOpen] = React.useState(false)
      /** 触发钮 + 面板的容器：点外面（mousedown）或按 Escape 就合上。 */
      const rootRef = React.useRef(null)

      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (rootRef.current !== null && rootRef.current.contains(event.target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('mousedown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      if (!Array.isArray(fields) || fields.length === 0) return null

      /** 点字段：插进目标位置并收菜单；mousedown 已 preventDefault，焦点还在输入框里。 */
      const pick = (field) => {
        setOpen(false)
        onInsert(`{{${field.name}}}`)
      }

      return jsxs('div', {
        className: 'dshpi-fieldmenu',
        ref: rootRef,
        children: [
          jsxs('button', {
            type: 'button',
            className: 'dshpi-fieldmenu-trigger',
            'data-open': open ? 'true' : 'false',
            'aria-haspopup': 'true',
            'aria-expanded': open ? 'true' : 'false',
            title: '模板字段：点字段插到最近编辑位置的光标处',
            // 关键：mousedown 抢焦点之前拦住，光标留在输入框里。
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => setOpen((value) => !value),
            children: [
              jsx('span', { children: '模板字段' }),
              jsx('span', { className: 'dshpi-fieldmenu-caret', children: jsx(primitives.IconChevronDownOutlineRegular, { size: 14 }) }),
            ],
          }),
          open
            ? jsxs('div', {
                className: 'dshpi-fieldmenu-pop',
                children: [
                  ...fields.map((field) =>
                    jsxs(
                      'button',
                      {
                        type: 'button',
                        className: 'dshpi-fieldmenu-item',
                        'aria-label': `插入模板字段 ${field.name}`,
                        onMouseDown: (event) => event.preventDefault(),
                        onClick: () => pick(field),
                        children: [
                          jsxs('span', {
                            className: 'dshpi-fieldmenu-name',
                            children: [
                              jsx('span', { className: 'dshpi-fieldmenu-token', children: `{{${field.name}}}` }),
                              jsx('span', { className: 'dshpi-fieldmenu-label', children: field.label }),
                            ],
                          }),
                          jsx('span', { className: 'dshpi-fieldmenu-note', children: field.note }),
                        ],
                      },
                      field.name,
                    ),
                  ),
                  jsx('div', {
                    className: 'dshpi-fieldmenu-hint',
                    children: '点击插入到位置输入框的光标处；一个位置都没开时，会自动填进第一个组的「用户前置词」并打开它。',
                  }),
                ],
              })
            : null,
        ],
      })
    }
    //#endregion

    //#region 位置行与组卡片
    /**
     * 一个位置行：关着时只有一行（开关 + 名字 + 标签 + 说明 + 已关闭），打开后才出现输入框。
     *
     * @param {object} props - 见下。
     * @returns {object} React 元素。
     */
    function PositionRow(props) {
      const { point, position, disabled, fields, onToggle, onEditText, onEditEnd, onNoteFocus, registerArea } = props
      const open = position.enabled === true
      const unknown = open ? unknownTemplateFields(position.text, fields) : []
      const empty = typeof position.text === 'string' && position.text === ''
      return jsxs('div', {
        className: 'dshpi-position',
        'data-open': open ? 'true' : 'false',
        children: [
          jsxs('div', {
            className: 'dshpi-position-head',
            children: [
              jsx(primitives.Switch, { checked: open, disabled, label: '启用这个位置', onChange: onToggle }),
              jsx('span', { className: 'dshpi-position-name', children: point.label }),
              point.kind === undefined ? null : jsx('span', { className: 'dshpi-kind', 'data-kind': point.kind, children: point.kind === 'replace' ? '替换' : '插进' }),
              point.anchor === undefined ? null : jsx('span', { className: 'dshpi-anchor', children: point.anchor }),
              point.hint === undefined ? null : jsx('span', { className: 'dshpi-hint', children: point.hint }),
              open ? null : jsx('span', { className: 'dshpi-count', children: '已关闭' }),
            ],
          }),
          open
            ? jsxs('div', {
                className: 'dshpi-position-body',
                children: [
                  point.notice === undefined ? null : jsx('div', { className: 'dshpi-notice', children: point.notice }),
                  jsx('textarea', {
                    className: 'dshpi-textarea',
                    value: typeof position.text === 'string' ? position.text : '',
                    disabled,
                    placeholder: '这段文字会按组顺序拼进该位置；留空则不注入',
                    ref: (element) => registerArea(element),
                    onFocus: (event) => onNoteFocus(event?.target),
                    onBlur: (event) => {
                      onNoteFocus(event?.target)
                      onEditEnd()
                    },
                    onChange: (event) => onEditText(event?.target),
                  }),
                  unknown.length > 0
                    ? jsx('div', {
                        className: 'dshpi-card-warn',
                        children: `提示：${unknown.map((name) => `{{${name}}}`).join('、')} 不是可用的模板字段，会原样保留。`,
                      })
                    : null,
                  empty ? jsx('div', { className: 'dshpi-muted', children: '留空视为不注入。' }) : null,
                ],
              })
            : null,
        ],
      })
    }

    /**
     * 一个组卡片：头部一行（折叠箭头 · 开关 · 组名 · 作用域 · 顺序 · 动作）+ 8 个位置行。
     * 位置只在展开时渲染；折叠后头部一行照常可操作。
     *
     * @param {object} props - 见下。
     * @returns {object} React 元素。
     */
    function GroupCard(props) {
      const { group, index, count, open, disabled, modelIndex, fields, onTogglePanel, onSetEnabled, onSetPositionEnabled, onEditGroup, onEditPosition, onEditEnd, onMove, onRequestRemove, onOpenScope, onEditText, onNoteFocus, registerArea } = props
      const summary = groupScopeSummary(group, modelIndex)
      const noScope = group.models?.all !== true && modelKeysOf(group).length === 0
      return jsxs('div', {
        className: 'dshpi-group-card',
        'data-off': group.enabled === true ? 'false' : 'true',
        'data-open': open ? 'true' : 'false',
        children: [
          jsxs('div', {
            className: 'dshpi-group-head',
            children: [
              jsxs('button', {
                type: 'button',
                className: 'dshpi-group-toggle',
                'aria-expanded': open ? 'true' : 'false',
                'aria-label': open ? '折叠这个组' : '展开这个组',
                title: open ? '折叠这个组' : '展开这个组',
                onClick: onTogglePanel,
                children: jsx('span', { className: 'dshpi-chevron', children: jsx(primitives.IconChevronRightOutlineRegular, { size: 16 }) }),
              }),
              jsx(primitives.Switch, {
                checked: group.enabled === true,
                disabled,
                label: '启用这个组',
                onChange: (next) => onSetEnabled(next),
              }),
              jsx(primitives.Input, {
                className: 'dshpi-group-name',
                value: typeof group.name === 'string' ? group.name : '',
                disabled,
                placeholder: '未命名组',
                'aria-label': '组名',
                onChange: (event) => onEditGroup((current) => ({ ...current, name: event.target.value })),
                onBlur: () => onEditEnd(),
              }),
              jsxs('button', {
                type: 'button',
                className: 'dshpi-scope',
                'data-all': summary.all ? 'true' : 'false',
                'data-inactive': summary.applied === 0 && !summary.all ? 'true' : 'false',
                disabled,
                title: '点击配置这个组的模型作用域',
                'aria-label': `组模型作用域：${summary.scopeText}，点击配置`,
                onClick: onOpenScope,
                children: [
                  jsx('span', { className: 'dshpi-scope-label', children: summary.scopeText }),
                  summary.invalid > 0 ? jsx('span', { className: 'dshpi-scope-invalid', children: `已失效 ${summary.invalid}` }) : null,
                ],
              }),
              group.enabled === true ? null : jsx('span', { className: 'dshpi-off-tag', children: '已停用' }),
              jsx('span', { className: 'dshpi-order', children: `第 ${index + 1} 组` }),
              jsx('div', { className: 'dshpi-spacer' }),
              jsxs('div', {
                className: 'dshpi-group-actions',
                children: [
                  jsx(primitives.Button, {
                    size: 'sm',
                    variant: 'ghost',
                    disabled: disabled || index === 0,
                    title: '上移',
                    'aria-label': '上移这个组',
                    icon: jsx(primitives.IconChevronUpOutlineRegular, { size: 16 }),
                    onClick: () => onMove(-1),
                  }),
                  jsx(primitives.Button, {
                    size: 'sm',
                    variant: 'ghost',
                    disabled: disabled || index === count - 1,
                    title: '下移',
                    'aria-label': '下移这个组',
                    icon: jsx(primitives.IconChevronDownOutlineRegular, { size: 16 }),
                    onClick: () => onMove(1),
                  }),
                  jsx('span', { className: 'dshpi-divider', 'aria-hidden': 'true' }),
                  jsx(primitives.Button, {
                    size: 'sm',
                    variant: 'ghost',
                    disabled,
                    title: '删除（需确认）',
                    'aria-label': '删除这个组',
                    icon: jsx(primitives.IconCloseOutlineRegular, { size: 16 }),
                    onClick: onRequestRemove,
                  }),
                ],
              }),
            ],
          }),
          noScope ? jsx('div', { className: 'dshpi-group-note', children: '这个组没有勾选「全部」也没有选择模型，当前不会注入。' }) : null,
          ...(open
            ? INJECT_POINTS.map((point) =>
                jsx(
                  PositionRow,
                  {
                    point,
                    position: group.positions?.[point.key] ?? emptyPosition(),
                    disabled,
                    fields,
                    onToggle: (next) => onSetPositionEnabled(point.key, next),
                    onEditText: (element) => onEditText(point.key, element),
                    onEditEnd,
                    onNoteFocus: (element) => onNoteFocus(point.key, element),
                    registerArea: (element) => registerArea(point.key, element),
                  },
                  point.key,
                ),
              )
            : []),
        ],
      })
    }
    //#endregion

    //#region 组作用域弹层
    /**
     * 组作用域的模型多选弹层（沿用旧版行为：勾选立即写回 group.models）。
     *
     * 按 provider 分组、可搜索、目录 degraded 时顶部说明、失效模型置灰并保留勾选
     * （取消勾选前按不匹配处理）。
     *
     * @param {object} props - 见下。
     * @returns {object} React 元素。
     */
    function GroupScopeDialog(props) {
      const { group, modelIndex, disabled, onEdit, onClose } = props
      const [query, setQuery] = React.useState('')
      const selected = new Set(modelKeysOf(group))
      const all = group?.models?.all === true
      const groups = modelIndex.providers
        .map((provider) => ({
          ...provider,
          models:
            query === ''
              ? provider.models
              : provider.models.filter(
                  (model) => `${provider.id}/${model.id}`.toLowerCase().includes(query.toLowerCase()) || model.name.toLowerCase().includes(query.toLowerCase()),
                ),
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
                  onChange: (next) => onEdit({ models: { all: next, list: modelKeysOf(group) } }),
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
                          children: jsx(primitives.Checkbox, { checked: true, disabled, label: `${key}（已失效）`, onChange: () => toggle(key) }),
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
                    jsx('div', { className: 'dshpi-model-group-title', children: provider.displayName ?? provider.id }),
                    ...provider.models.map((model) => {
                      const key = `${provider.id}/${model.id}`
                      return jsxs(
                        'div',
                        {
                          className: 'dshpi-model-row',
                          children: [
                            jsx(primitives.Checkbox, { checked: selected.has(key), disabled, label: model.name ?? model.id, onChange: () => toggle(key) }),
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

    /**
     * 组作用域弹层的外壳：没开组时什么都不渲染；换组时靠 key 重置搜索词。
     *
     * @param {object} props - 见下。
     * @returns {object | null} React 元素。
     */
    function GroupScopeModal(props) {
      const { group, modelIndex, disabled, onEdit, onClose } = props
      if (group === undefined) return null
      return jsx(GroupScopeDialog, { key: group.id, group, modelIndex, disabled, onEdit, onClose })
    }
    //#endregion

    //#region 删除确认
    /**
     * 删除组的二次确认弹层。
     *
     * @param {object} props - 见下。
     * @returns {object | null} React 元素。
     */
    function RemoveGroupModal(props) {
      const { group, index, disabled, onCancel, onConfirm } = props
      if (group === undefined) return null
      const name = typeof group.name === 'string' && group.name.trim() !== '' ? group.name : `组 ${index + 1}`
      return jsx(primitives.Modal, {
        open: true,
        title: '删除组',
        closeLabel: '取消',
        description: `确定删除组「${name}」吗？删除后不能撤销。`,
        onClose: onCancel,
        footer: jsxs(React.Fragment, {
          children: [
            jsx(primitives.Button, { variant: 'outline', onClick: onCancel, children: '取消' }),
            jsx(primitives.Button, { variant: 'primary', disabled, onClick: onConfirm, children: '删除' }),
          ],
        }),
        children: jsx('div', { className: 'dshpi-muted', children: `组「${name}」里的 8 个位置内容会一起删掉。` }),
      })
    }
    //#endregion

    //#region 页面
    /**
     * 设置页。
     *
     * @param {object} props - 槽位给的 props（含 useGroups 与各动作）。
     * @returns {object} React 元素。
     */
    function SettingsView(props) {
      const state = props.useGroups((snapshot) => snapshot)
      const { status, message, groups, fields, catalog, pendingRemoveGroupId, openGroupScope, collapsedGroups, toast } = state
      const disabled = false
      const modelIndex = React.useMemo(() => {
        const keys = new Set()
        for (const provider of catalog?.providers ?? []) for (const model of provider.models) keys.add(`${provider.id}/${model.id}`)
        return { keys, providers: catalog?.providers ?? [], degraded: catalog?.degraded === true }
      }, [catalog])

      /** 开着的组作用域弹层对应的组。 */
      const openScopeGroup = React.useMemo(() => groups.find((group) => group.id === openGroupScope), [groups, openGroupScope])

      /** 待确认删除的组。 */
      const removeTarget = React.useMemo(() => {
        if (pendingRemoveGroupId === undefined) return undefined
        const index = groups.findIndex((group) => group.id === pendingRemoveGroupId)
        return index < 0 ? undefined : { group: groups[index], index }
      }, [groups, pendingRemoveGroupId])

      /** 是否所有组都折起来了（悬浮栏「全部折叠 / 全部展开」按钮的文案依据）。 */
      const allCollapsed = groups.length > 0 && groups.every((group) => (collapsedGroups ?? {})[group.id] === true)

      /**
       * 页面上所有位置输入框（嵌套 Map：组 id → 位置键 → 元素）。
       * 用嵌套 Map 而不是拼字符串键：组 id 里可能带分隔符，拼起来会撞。
       */
      const areasRef = React.useRef(new Map())
      /** 最近聚焦过的位置输入框（`{ groupId, pointKey, start, end }`），开下拉时它可能已失焦但仍是插入目标。 */
      const lastFocusRef = React.useRef(undefined)

      /**
       * 记一个输入框的焦点与光标位置。
       * @param {string} groupId - 组 id。
       * @param {string} pointKey - 注入点键。
       * @param {HTMLElement | null | undefined} element - textarea 元素。
       * @returns {void}
       */
      const noteFocus = (groupId, pointKey, element) => {
        lastFocusRef.current = {
          groupId,
          pointKey,
          start: typeof element?.selectionStart === 'number' ? element.selectionStart : undefined,
          end: typeof element?.selectionEnd === 'number' ? element.selectionEnd : undefined,
        }
      }

      /**
       * 登记一个位置输入框（element 为 null/undefined 表示卸载，顺手注销）。
       * @param {string} groupId - 组 id。
       * @param {string} pointKey - 注入点键。
       * @param {HTMLElement | null | undefined} element - textarea 元素。
       * @returns {void}
       */
      const registerArea = (groupId, pointKey, element) => {
        if (element === null || element === undefined) {
          const inner = areasRef.current.get(groupId)
          if (inner !== undefined) {
            inner.delete(pointKey)
            if (inner.size === 0) areasRef.current.delete(groupId)
          }
          return
        }
        let inner = areasRef.current.get(groupId)
        if (inner === undefined) {
          inner = new Map()
          areasRef.current.set(groupId, inner)
        }
        inner.set(pointKey, element)
      }

      /**
       * 某个 DOM 元素是不是已登记的位置输入框。
       * @param {HTMLElement | null | undefined} element - DOM 元素。
       * @returns {{ groupId: string, pointKey: string } | undefined} 命中信息。
       */
      const findAreaByElement = (element) => {
        if (element === null || element === undefined) return undefined
        for (const [groupId, inner] of areasRef.current) {
          for (const [pointKey, node] of inner) if (node === element) return { groupId, pointKey }
        }
        return undefined
      }

      /**
       * 最近聚焦的目标是否还能用：组和位置都还在，并且位置仍然开着（关掉后输入框已卸载）。
       * 这里按配置判断而不是按 DOM 登记表：上报焦点时输入框一定开着，之后只可能被关掉或删掉。
       * @param {{ groupId: string, pointKey: string } | undefined} target - 目标。
       * @returns {boolean} 是否还能用。
       */
      const focusTargetAlive = (target) => {
        if (target === undefined) return false
        const group = groups.find((item) => item.id === target.groupId)
        return group !== undefined && group.positions?.[target.pointKey]?.enabled === true
      }

      /**
       * 把光标放回某个输入框（等这一帧提交完再摆）。
       * @param {string} groupId - 组 id。
       * @param {string} pointKey - 注入点键。
       * @param {number} caret - 光标位置。
       * @returns {void}
       */
      const focusArea = (groupId, pointKey, caret) => {
        setTimeout(() => {
          const node = areasRef.current.get(groupId)?.get(pointKey)
          if (node === undefined || node === null) return
          node.focus?.()
          node.setSelectionRange?.(caret, caret)
        }, 0)
      }

      /**
       * 把 token 写进某个位置（`extra` 用来顺手打开位置），并记住新光标。
       * @param {string} groupId - 组 id。
       * @param {string} pointKey - 注入点键。
       * @param {string} baseText - 原文本。
       * @param {number} start - 选区起点。
       * @param {number} end - 选区终点。
       * @param {string} token - 要插入的文本。
       * @param {object} [extra] - 额外的位置补丁（例如 `{ enabled: true }`）。
       * @returns {void}
       */
      const applyTextAt = (groupId, pointKey, baseText, start, end, token, extra) => {
        props.editPosition(groupId, pointKey, { ...extra, text: insertAtCaret(baseText, token, start, end) })
        const caret = (Number.isInteger(start) ? start : baseText.length) + token.length
        lastFocusRef.current = { groupId, pointKey, start: caret, end: caret }
        focusArea(groupId, pointKey, caret)
      }

      /**
       * 把 `{{字段}}` 插进目标位置。目标怎么选：
       * 1. 焦点还在某个位置输入框里（开下拉的常规路径，mousedown 没抢焦点）→ 用它，插在光标处；
       * 2. 最近聚焦过的那条（还挂载着才算数）→ 用它，插在记录的光标处；
       * 3. 都没试过输入框 → 第一个有「位置启用且文本非空」的组的最后一个这类位置，追加到末尾；
       * 4. 一个都没开/没写 → 第一个组的 user.prefix，自动打开并填入；
       * 5. 零组 → 先用 addGroup(token) 建 组 1（user.prefix 已打开填好）。
       *
       * @param {string} token - 要插入的文本（`{{字段}}`）。
       * @returns {void}
       */
      const insertToken = (token) => {
        const active = typeof document === 'undefined' ? undefined : findAreaByElement(document.activeElement)
        if (active !== undefined) {
          const node = areasRef.current.get(active.groupId)?.get(active.pointKey)
          const group = groups.find((item) => item.id === active.groupId)
          const text = group?.positions?.[active.pointKey]?.text
          applyTextAt(active.groupId, active.pointKey, typeof text === 'string' ? text : '', node?.selectionStart, node?.selectionEnd, token)
          return
        }

        const last = lastFocusRef.current
        if (focusTargetAlive(last)) {
          const group = groups.find((item) => item.id === last.groupId)
          const text = group?.positions?.[last.pointKey]?.text
          applyTextAt(last.groupId, last.pointKey, typeof text === 'string' ? text : '', last.start, last.end, token)
          return
        }

        for (const group of groups) {
          let target
          for (const point of INJECT_POINTS) {
            const block = group.positions?.[point.key]
            if (block?.enabled === true && typeof block.text === 'string' && block.text !== '') {
              target = { groupId: group.id, pointKey: point.key, text: block.text }
            }
          }
          if (target !== undefined) {
            applyTextAt(target.groupId, target.pointKey, target.text, undefined, undefined, token)
            return
          }
        }

        if (groups.length > 0) {
          const group = groups[0]
          const block = group.positions?.['user.prefix']
          const base = typeof block?.text === 'string' ? block.text : ''
          applyTextAt(group.id, 'user.prefix', base, undefined, undefined, token, { enabled: true })
          return
        }

        // 零组：一次建好 组 1 并把字段填进它的 user.prefix。
        const created = props.addGroup(token)
        if (typeof created === 'string') {
          const caret = token.length
          lastFocusRef.current = { groupId: created, pointKey: 'user.prefix', start: caret, end: caret }
          focusArea(created, 'user.prefix', caret)
        }
      }

      return jsxs('div', {
        className: 'dshpi-root',
        'data-busy': status === 'loading' ? 'true' : 'false',
        children: [
          jsxs('div', {
            className: 'dshpi-bar',
            children: [
              jsx(TemplateFieldsMenu, { fields, onInsert: insertToken }),
              groups.length === 0
                ? null
                : jsx(primitives.Button, {
                    size: 'sm',
                    variant: 'outline',
                    'aria-label': allCollapsed ? '全部展开' : '全部折叠',
                    title: allCollapsed ? '展开所有组' : '折叠所有组',
                    onClick: () => props.toggleCollapseAll(),
                    children: allCollapsed ? '全部展开' : '全部折叠',
                  }),
              jsxs('div', {
                className: 'dshpi-status',
                children: [jsx('span', { className: 'dshpi-dot', 'data-state': status }), jsx('span', { className: status === 'failed' ? 'dshpi-muted' : status === 'waiting' ? 'dshpi-waiting-text' : undefined, children: message ?? '' })],
              }),
              groups.length === 0
                ? null
                : jsx('div', {
                    className: 'dshpi-bar-note',
                    children: '同一个位置里按组从上到下拼接；组或位置关闭、留空都会自动跳过。',
                  }),
            ],
          }),
          groups.length === 0
            ? jsxs('div', {
                className: 'dshpi-empty-state',
                role: 'button',
                tabIndex: 0,
                onClick: () => props.addGroup(),
                onKeyDown: (event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  props.addGroup()
                },
                children: [
                  jsx('div', { className: 'dshpi-empty-title', children: '还没有注入规则' }),
                  jsx('div', { className: 'dshpi-empty-cta', children: '＋ 新建组' }),
                ],
              })
            : [
                ...groups.map((group, index) =>
                  jsx(
                    GroupCard,
                    {
                      group,
                      index,
                      count: groups.length,
                      open: (collapsedGroups ?? {})[group.id] !== true,
                      disabled,
                      modelIndex,
                      fields,
                      onSetEnabled: (next) => props.setGroupEnabled(group.id, next),
                      onSetPositionEnabled: (pointKey, next) => props.setPositionEnabled(group.id, pointKey, next),
                      onEditGroup: (change) => props.editGroup(group.id, change),
                      onEditPosition: (pointKey, patch) => props.editPosition(group.id, pointKey, patch),
                      onEditEnd: () => props.flushSave(),
                      onMove: (delta) => props.moveGroup(group.id, delta),
                      onTogglePanel: () => props.toggleGroupPanel(group.id),
                      onRequestRemove: () => props.requestRemoveGroup(group.id),
                      onOpenScope: () => props.openGroupScope(group.id),
                      onEditText: (pointKey, element) => {
                        noteFocus(group.id, pointKey, element)
                        props.editPosition(group.id, pointKey, { text: typeof element?.value === 'string' ? element.value : '' })
                      },
                      onNoteFocus: (pointKey, element) => noteFocus(group.id, pointKey, element),
                      registerArea: (pointKey, element) => registerArea(group.id, pointKey, element),
                    },
                    group.id,
                  ),
                ),
                jsx(primitives.Button, {
                  className: 'dshpi-add-group',
                  size: 'sm',
                  variant: 'outline',
                  disabled,
                  onClick: () => props.addGroup(),
                  children: '＋ 新增组',
                }),
              ],
          jsx(GroupScopeModal, {
            group: openScopeGroup,
            modelIndex,
            disabled,
            onEdit: (patch) => {
              if (openScopeGroup !== undefined) props.setGroupModels(openScopeGroup.id, patch.models)
            },
            onClose: () => props.openGroupScope(undefined),
          }),
          jsx(RemoveGroupModal, {
            group: removeTarget?.group,
            index: removeTarget?.index ?? 0,
            disabled,
            onCancel: () => props.cancelRemoveGroup(),
            onConfirm: () => props.confirmRemoveGroup(),
          }),
          toast === undefined
            ? null
            : jsx('div', {
                className: 'dshpi-toast',
                children: jsx(primitives.Toast, {
                  text: toast.text,
                  tone: toast.tone,
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
      const controller = new Controller(API, (message, error) => {
        ctx.logger?.('dsh-prompt-inject')?.warn(`${message}: ${String(error?.message ?? error)}`)
      })
      ctx.effect(() => insertStyles(), 'dsh-prompt-inject: styles')
      ctx.effect(() => () => {
        // 页面卸载/插件停用：把没来得及保存的编辑发出去（没有待保存内容时 flushSave 是空操作）。
        controller.flushSave()
        if (controller.timer !== undefined) clearTimeout(controller.timer)
        if (controller.catalogTimer !== undefined) clearTimeout(controller.catalogTimer)
      }, 'dsh-prompt-inject: timers')
      void controller.load()

      // 官方的「模型 / 设置 / 密钥变了」是把事件推给浏览器的（官方模型设置页也听这几条），
      // 收到就重拉目录 —— 所以加删改模型不用重启 dsh，页面里下一拍就是新的。
      //
      // `remote` 走 inject 而不是硬用：服务没挂（比如极简壳）时这个子插件只是不激活，
      // 设置页照旧能开，退回「打开页面时拉一次」的旧行为。
      ctx.inject(['remote'], (scoped) => {
        scoped.effect(() => {
          const disposers = CATALOG_INVALIDATION_EVENTS.map((event) => scoped.remote.$on(event, () => controller.invalidateCatalog()))
          // 断线重连期间推的事件会丢，重连后补拉一次。
          disposers.push(scoped.on('connection/reset', () => controller.invalidateCatalog()))
          return () => {
            for (const dispose of disposers) dispose()
          }
        }, 'dsh-prompt-inject: model catalog invalidations')
      })

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'promptInject',
            order: 50,
            label: () => 'dsh-prompt-inject',
            inject: () => ({
              hooks: { groups: controller },
              addGroup: (text) => controller.addGroup(text),
              editGroup: (groupId, change) => controller.editGroup(groupId, change),
              setGroupEnabled: (groupId, enabled) => controller.setGroupEnabled(groupId, enabled),
              setGroupModels: (groupId, models) => controller.setGroupModels(groupId, models),
              editPosition: (groupId, pointKey, patch) => controller.editPosition(groupId, pointKey, patch),
              setPositionEnabled: (groupId, pointKey, enabled) => controller.setPositionEnabled(groupId, pointKey, enabled),
              moveGroup: (groupId, delta) => controller.moveGroup(groupId, delta),
              requestRemoveGroup: (groupId) => controller.requestRemoveGroup(groupId),
              cancelRemoveGroup: () => controller.cancelRemoveGroup(),
              confirmRemoveGroup: () => controller.confirmRemoveGroup(),
              openGroupScope: (groupId) => controller.openGroupScope(groupId),
              toggleGroupPanel: (groupId) => controller.toggleGroupPanel(groupId),
              toggleCollapseAll: () => controller.toggleCollapseAll(),
              flushSave: () => controller.flushSave(),
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

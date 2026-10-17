# 客户端半适配 2026-10-17（DSH 0.2.0-rc.2 → 0.2.1-rc.2）

## 一句话结论

客户端半**没有别的破坏**：模块注册形状、primitives 导出、组件 props、remote 事件、`settings.section` 槽位全都没变，
`lib/client.js` 不需要为新版本改代码。只改了一条提示文案（0.2.1 不再有 cwd 的 persona 尾）。
整包不加载是 host 侧 `engines.dsh` 门槛（Lead 已改 package.json），不是客户端半的问题。

证据基线：live 装的就是 0.2.1-rc.2。我直接从 `%ProgramFiles%\...\resources\app.asar` 读了版本和关键包，
跟 `%TEMP%\dsh-pi\ok-021` 的平铺包**逐字节一致**（`index-CN7NIWNw.js` SHA256 `4BC914BF...`；api-gateway / ui-renderer /
settings / settings-general 的 `lib/client.js` 哈希全同），所以下面引用 ok-021 的行号就是 live 运行时的代码。

## 改动

| 文件 | 改了什么 |
|---|---|
| `lib/client.js` | `system.personaTail` 的 hint：`改写…（官方用于告知当前工作目录位置）…` → `替换官方 persona 段的尾（0.2.1 起官方默认为空串）；不配就保持官方默认。`（与 host `lib/injectPoints.js:65` 逐字一致） |
| `.agents/checks/verify-client-modules.mjs` | 新增**手工探针**：拿 0.2.1 真 `client-modules` 浏览器模块系统跑一遍 `lib/client.js`。没接进 `run.mjs`（`run.mjs` 不在我写作用域；要接的话挂到 B 组） |

host 侧 `lib/systemSections.js:112` 的注释还写着「官方自己的 `{{cwd}}` 还要靠它的插值器渲染」，0.2.1 已不注册 `cwd` 变量，
这句注释过时了——host 文件不归我改，转给 host 半。

## 逐项核对

### 1. 模块加载形状（没变）

- 插件 bundle 仍是 `window.__ModuleLoader__.load({ id, factory })`；0.2.1 的 `register()` 只认 `{ id, factory, chunk? }`，
  id 去掉 `/client` 后缀后当模块身份（`ok-021\dsh-client-modules\lib\client.js:701-714`）。
- `require` 顺序还是「seed → 已物化 → 已注册 factory」（同上 `:831-850`）；插件只 require `react`、`react/jsx-runtime`、
  `@deepseek-ai/dsh-client-ui-primitives`，全在平台 seed 表（见下）。
- `dsh.client` 声明解析器 `parseDshClient` 只读 `platform/inject/external/immediately`，其余字段忽略
  （`dsh-client-modules\lib\index.js:62-76`）；插件现有声明合法。
- `dsh.client.inject`：只有「boot graph 里有的行」会被排到前面先加载，其余安静忽略
  （host 组装 `index.js:402-444`，浏览器到达 `client.js:776-794`）。`@deepseek-ai/dsh-client-ui-settings` 是 graph 行，
  保留有意义；primitives 不是（0.2.1 起磁盘上没这个包、也不是 loader 行），Lead 删掉是对的，留着也只是死引用、不报错。
- `dsh.client.external`：**不需要加**。`external` 不是 0.2.1 新字段（0.2.0 的 `dsh-client-modules\lib\client.js` 同样有、
  语义一样），它只用于「基座之外的动态包请求」。插件用到的 3 个模块都是基座 seed：
  live 前端 `index-CN7NIWNw.js` 的 `SZ()`（`:918155`）返回 react / react/jsx-runtime / … / `@deepseek-ai/dsh-client-ui-primitives`
  （对应导出对象 `zU`，`:861130`）。加 external 反而语义不对。
- 端到端验证：`node .agents/checks/verify-client-modules.mjs` 用 0.2.1 真模块系统 import 插件，全 PASS；
  负向对照（seed 去掉 primitives）会立刻报 `require(...) missed the module table`，证明它确实由 seed 提供。

### 2. primitives 导出（都在）

新版 primitives 只在 live 前端 bundle 里（`zU`），旧版是独立包 `ok\dsh-client-ui-primitives\lib\index.js`。
用脚本对了两张导出表的键：旧 282 个、新 288 个；新版只少了 `projectUserText`（插件没用到），多了 8 个
（`CommandText/HoverCardGroup/InlineEditor/PermissionIconAutoReview*/ReferenceChip/UserTextRun`）。
插件用的 11 个全在，逐个对上：

| 插件用到的导出 | 新版 bundle 里的位置（`index-CN7NIWNw.js`） | 旧包导出表（`ok\...\lib\index.js`） |
|---|---|---|
| Button | `n2` @642418 | `:3216` |
| Input | `YD` @646479 | `:3529` |
| Checkbox | `GD` @646208 | `:3507` |
| Switch | `BD` @644623 | `:3394` |
| Modal | `S_` @668318 | `:5210` |
| Toast | `iR` @777341 | `:6831` |
| IconChevronUpOutlineRegular | `Fv` @572821 | `:593` |
| IconChevronDownOutlineRegular | `Nv` @570769 | `:497` |
| IconChevronRightOutlineRegular | `GT` @571549 | `:530` |
| IconCloseOutlineRegular | `ru` @573212 | `:620` |
| IconCopyOutlineRegular | `t4` @574528 | `:704` |

### 3. props 契约（零差异）

把新旧实现逐段对照，签名和渲染结构一模一样：

- `Button({ variant = 'ghost', size = 'md', icon, className, children, ...rest })`（forwardRef）→ 旧 `:3216` / 新 `:642418`
- `Input({ icon, className, ...rest })`（forwardRef）→ 旧 `:3529` / 新 `:646479`
- `Checkbox({ checked, onChange, label, disabled = false, title, className })` → 旧 `:3507` / 新 `:646208`
- `Switch({ checked, onChange, label, disabled = false, title, className })` → 旧 `:3394` / 新 `:644623`
- `Modal({ open, onClose, title, closeLabel, description, children, footer, className, contentClassName, onKeyDownCapture, headless = false, backdropBlur = true, shortcutModal })` → 旧 `:5210` / 新 `:668318`
- `Toast({ text, icon, tone, anchor, holdMs = 3000, actions, onDone })`，`actions[].{prefix,label,onClick}` 原样渲染、淡出后调 `onDone` → 旧 `:6831` / 新 `:777341`
- 5 个图标的 `({ size = …, className, strokeWidth })` 参数与默认值也没变（chevron/close/copy 的 `size` 默认值分别是 14/16/16，插件都显式传 16，无影响）。

所以 `lib/client.js` 里所有 `primitives.*` 调用点（Switch/Button×3/Modal/Checkbox×3/Input/Toast/图标）不用动。

### 4. remote 服务与转发事件（没变）

- `remote` 服务仍由 `dsh-api-gateway` 的浏览器半边提供：`super(ctx, 'remote')`（`ok-021\dsh-api-gateway\lib\client.browser.js:1626`），
  `$on(event, listener)` 仍在（`:1680-1683`，返回退订函数），`connection/reset` 仍在重连成功时 emit（`:1640`）。
  官方 0.2.1 的客户端插件也大量用 `ctx.remote.$on` / `scoped.on('connection/reset')`，用法与插件一致。
- 转发事件白名单 `API_REMOTE_FORWARDED_EVENTS`（`ok-021\dsh-api-remotes\lib\index.js:21-139`）仍然包含
  `llm/adapters-updated`（`:104`）、`settings/document-updated`（`:128`）、`credentials/record-updated`（`:68`）、
  `credentials/reference-updated`（`:72`）；跟 0.2.0 比只多了一条 `plugin-market/changed`。
- `client-shape.mjs` 里「client 订阅的失效事件表与 host 的 `CATALOG_INVALIDATION_EVENTS` 一致」这项仍然通过。

### 5. `settings.section` 槽位（没变）

- 官方样例与插件同构：`ctx.slots.inject('settings.section', () => ctx.slots.register({…}))`
  （`ok-021\dsh-client-ui-settings-general\lib\client.js:1293-1303`；挂载点 `:337`；声明 `sidebar.settings > settings.section: list` 在 `:1258-1261`）。
- 注册选项 `{ name, id, order, label, inject }` 合法；`label` 是 thunk 也能被 `resolveSlotLabel` 解析。
- `inject` 面里的 `hooks.rules` 仍然会变成组件的 `useRules`：renderer 的 `bindInjectSources`
  （`ok-021\dsh-client-ui-renderer\lib\client.js:444-459`）/ `cachedSlotInject`（`:463-489`）与 0.2.0 逻辑相同；
  `standardHookPropName` 实现还是 `use${Name}`（新版 bundle 里 `xI` @486911，旧 `ok\dsh-client-ui-slots\lib\index.js:7-9`）。
- 设置页导航对槽位变化是响应式的：`settings-general` 的 sections store 用 `ctx.slots.getVersion('settings.section')`
  + `ctx.slots.subscribe('settings.section', …)` 重算列表（`:1138-1161`），所以槽位一注册导航就更新。

## 热加载：能不能不刷新页面、不重启就出现新设置页？

**客户端半可以，而且链路是现成的。** 前提是 host 侧能「活着重组 profile」让这个 loader 条目真正被创建/启动
（当前它就是被 app-boot 的兼容门槛拦掉、压根没有条目）。

链路（全部是 live 装的那份代码）：

1. host：loader 条目启动 → cordis `internal/plugin` 事件 → `client-modules` 标脏并微任务 flush
   （`ok-021\dsh-client-modules\lib\index.js:545-557`）→ `compose()` 重组 → `notifyGraphChanged()`
   （`:912-932`、`:661-666`）。
2. `dsh-client-hmr` 的 host 半边把整张图通过 `/plugins/events` SSE 发出去（`ok-021\dsh-client-hmr\lib\index.js:117-123`、`:140-169`）；
   这个包是 web 组合里**常驻**的行（`ok-021\dsh-web-app\cordis.patch.yml:218-219`）。
3. 浏览器：`dsh-client-hmr` 收到 `type:'graph'` 帧 → `ctx.modules.entries.sync(graph)`
   （`ok-021\dsh-client-hmr\lib\client.js:269-287`，SSE/EventSource 在 `:288-306`）。
4. `client-modules` 浏览器半边 `sync` → 版本门通过 → `reconcile`：新行 `prefetch`/`import` 后 `create(loader, id)`
   （`ok-021\dsh-client-modules\lib\client.js:407-414`、`:506-570`）。这里**不会重放启动 combo**：
   `updateManifest` 把每行的 `initialUrl` 换成了单资源 URL（`:919-935`），`arrive` 优先用它（`:743-775`），
   所以新条目只拉 `/plugins/dsh-prompt-inject/client.js?rev=…`，不碰老 batch、不会重复注册。
5. Loader 激活条目 → 插件的 `apply()` 执行 → `ctx.slots.inject('settings.section', register)` + 样式 effect →
   槽位账本变化 → 设置页导航/内容重渲染。**不需要刷新页面，也不需要重启 app**。

host 侧「怎么触发一次活的重组」（不用重启）：
`dsh-hmr` 在监听 profile 的 `package.json` 和 `~/.dsh/cordis.patch.yml` / profile patch 文件（`ok-021\dsh-hmr\lib\index.js:849-873`），
一有变化就 `reconcileProfile()` → `recomposeProfile()`（`:1320-1362`；`ok-021\dsh-app-boot\lib\index.js:3782-3884`）：
重新从磁盘读 bundle 层、重跑兼容 preflight（`app-boot\lib\index.js:2305-2357`，manifest 是 `readFileSync` 直读、没有缓存），
再把新 generation 应用到正在跑的 root Include。所以改完 `package.json` 后，**改一下 profile 的 `cordis.patch.yml`
（哪怕只动一行注释）或从插件页启用/切换一次插件**，就能热重组；重组后客户端半会自动跟上，页面不用刷新。

注意两点：

- 只改插件目录里的 `package.json` **不会**自动触发（它不在 profile 的 watch 列表里）；要碰 profile 的 patch/manifest 内容。
- 图帧有 release 门：页面启动时是 0.2.0 的话，0.2.1 host 的图会被忽略，那种情况需要刷新一次页面。现在两端都是 0.2.1，没这问题。
- 万一 `/plugins/events` 断了，图更新会停到刷新为止（`dsh-client-hmr\lib\client.js:262` 会报错）——正常运行时不会。

## 测试

- `node .agents/checks/run.mjs a` → 5/5 全绿（改 hint 之后重跑过）。
- `node .agents/checks/verify-client-modules.mjs` → 14 项全 PASS（手工探针，需官方包；没接 run.mjs）。

## 存疑 / 留给 Lead

1. **client inspect 一直超时**（`client` platform 的 Service/Event/Builtin/Slots 试了 4 次都 10s 超时），只有 host inspect 可用；
   所以 live 侧我用「安装包逐字节核对 + host `hmr`/`clientModules` service 存在」代替，没拿到 live 的槽位树。
2. **`client-shape.mjs` 只校验 `notice`，不校验 `hint`**（不是你以为的会逐字比对文案）。personaTail 已按你的 host 文案原样写；
   personaHead 那边 client 一直写「改写…」而 host 写「替换…」，本来就不同、这次没动。要强制全表 hint 一致的话说一声（会牵动 8 条文案）。
3. personaHead 的旧说法「官方用于告知模型当前调用的模型名」在 0.2.1 **仍然成立**：web-app 的 `personaPrefix` 还是
   `You are a coding agent powered by the {{model}} model.`（`ok-021\dsh-web-app\cordis.patch.yml:19-21`），
   官方也仍注册 `model`/`provider` 变量（`ok-021\dsh-agent-loop\lib\index.js:1591-1592`）。只有 `cwd` 变量没了（0.2.0 是 `:1564-1566`），
   对应 `personaSuffix` 那行也从 web-app patch 删了（0.2.0 `:18`）。
4. 插件显示用的 `order 950 / 3050 / 9800 / 10300` 锚点在 0.2.1 仍准确：`SECTION_ORDERS` 两版逐个相等
   （`ok-021\dsh-system-prompt\lib\index.js:10-42`），只是 `CONTEXT_ORDERS` 新增了 `WORKING_DIRECTORY: 100`（cwd 改由 runtime context 下发）。
5. `dsh.client.external` 不是「新版才有的」字段，别为它加声明；`dsh.client.inject` 里只留 settings 是对的。
6. peerDependencies 里留 primitives 对**客户端半**没有影响（浏览器解析不走 peer 表），host 那边要不要留由你/ host 半判断。

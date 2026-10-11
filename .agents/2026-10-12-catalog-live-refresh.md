# 2026-10-12：模型目录实时刷新（增删改模型不用重启 dsh）

## 用户的要求

当时的行为：在 DSH 里加 / 删 / 改模型，设置页的模型作用域看不到变化，**只有重启 dsh 宿主才会刷新**。
要求改成：模型设置一改就实时捕获到列表变更。

## 官方那边的事实（从发行包 `app.asar` 读出来的）

- **`llm` 本身不缓存模型目录**：`listModels(provider)` 每次都问适配器（`@deepseek-ai/dsh-llm/lib/index.js`），
  pi-ai 那类适配器读的是当前 config 快照。所以「不新鲜」只可能是我们自己的缓存 + 界面不重拉造成的。
- **官方有一份「会推给浏览器的宿主事件」白名单**：`@deepseek-ai/dsh-api-remotes` 的
  `API_REMOTE_FORWARDED_EVENTS`（`lib/types/remote-events.js`）。名字不在里面 = 推送根本不会出门。
  我们要的四条都在：`llm/adapters-updated`、`settings/document-updated`、
  `credentials/record-updated`、`credentials/reference-updated`。
- **官方模型设置页听的正是这四条**：`@deepseek-ai/dsh-client-ui-settings-models` 的 `apply` 里
  `refreshModels`（`refreshIfLoaded`），另外还挂了 `connection/reset`。这是照着抄的依据，不是猜的。
- **事件是谁发的**：`llm/adapters-updated` ← `dsh-llm` 的 `emitAdaptersUpdated()`（注册 / 换路由 / 声明
  configurable provider 时都发）；`settings/document-updated` ← `dsh-settings` 写盘后 `emit`；
  `credentials/*-updated` ← `dsh-credentials` 的 `fanOut`。
- **客户端的 `ctx.remote` 由 `@deepseek-ai/dsh-api-gateway` 的 `ClientRemoteService` 提供**；
  `$on(event, listener)` 就是 `ctx.on('internal/api-gateway/remote-event/<uuid>/' + event, listener)`，
  运行时**不校验**事件名（白名单只在类型层），所以名字写错是静默失灵——必须对着白名单核。
- cordis 的事件总线是全局一张 `_hooks` 表，且 emit 时没有 `thisArg`（无上下文过滤），
  所以**任何 fiber**（包括官方服务自己的 ctx）emit 的事件，我们的监听器都收得到。

## 改了什么

### host（`lib/settingsApi.js`）

- 新增 `CATALOG_INVALIDATION_EVENTS`（就是上面四条）：事件一响就**清目录缓存**，下一次读现算。
  只在事件里清、不在事件里拉：没人问就不花这次开销。
- 目录缓存抽成 `readCatalogCached()`，`/state` 与新的 `/catalog` 共用一份；30 秒 TTL 保留当兜底。
- **新增 `GET /api/dsh-prompt-inject/catalog`**，只回 `{ providers, degraded }`。

### client（`lib/client.js`，手写 bundle）

- `Controller` 新增 `invalidateCatalog()`（合并 150ms 再拉）与 `refreshCatalog()`：
  **只替换 `catalog` 一个字段**，规则、`revision`、保存状态一律不碰。
- `apply()` 里用 `ctx.inject(['remote'], scoped => ...)` 订阅那四条事件 + `connection/reset`，
  统一走 `invalidateCatalog()`。
- 拉失败 / 老 host 回 404：静静留着旧目录，只往日志里写一行，不改状态、不打断用户。

### 为什么要另开 `/catalog`，而不是复用 `/state`

设置页的规则是**本地乐观更新 + 500ms debounce**。推送触发时用户很可能正在打字，
整包重读 `/state` 会把那份还没提交的编辑冲掉（服务端那份还是旧的）。所以目录单独一条路，
`verify-catalog-refresh.mjs` 里专门盯着「重拉不动规则 / revision / 保存状态」。

### 为什么用 `ctx.inject(['remote'])` 而不是把 `remote` 写进 `inject` 数组

写进 `inject` 会让整个客户端插件等到 `remote` 出现才激活（服务缺失时设置页直接不来）；
`ctx.inject` 只让**这一个子插件**待命：`remote` 没挂时设置页照旧注册，退回「打开页面拉一次」的旧行为；
网关插件排在后面时才挂上也没关系，订阅会补上。

## 验收

- `.agents/checks/verify-catalog-events.mjs`（**真 cordis**，官方服务用替身，12 条）：
  先核官方白名单里确实有这四条；再把每条各推一次，断言目录缓存**当场**失效（长出来又缩回去都看得见）；
  最后停用插件，断言端点与监听器一起消失（官方那套「禁用再启用」式热重载不能攒监听器）。
- `.agents/checks/verify-catalog-refresh.mjs`（客户端半，真 `Controller`）：
  推送 → 重拉、连推三条只合并成一次、**只换目录**、拉失败留旧目录、老 host 404 不炸；
  第二段用真 cordis 验「`remote` 晚挂上也会补上订阅」。
- `verify-host-wiring.mjs`：端点从 2 条变 3 条、`/catalog` 内容、四条失效事件都挂上、
  事件之后能拉到新模型、事件只清缓存（紧接着再拉不再问 provider）。
- `client-shape.mjs`：订阅的事件与 host 的 `CATALOG_INVALIDATION_EVENTS` **逐字对表**（+ `connection/reset`）。
- `verify-panel-toggle.mjs` / `verify-card-render.mjs`：ctx 替身补 `inject`（契约没变）。

## 文档

`docs/settingGUI.md` 新增「模型目录什么时候刷新」一节 + 端点表补 `/catalog` + 「已失效」那条补实时刷新；
`README.md` 的模型作用域加一条「不用重启」、已知限制里写明边界、开发命令补两个脚本；
`.agents/checks/README.md` 补脚本说明。

## 边界（没做到 / 不打算做的）

- **宿主半要热重载或重启才吃到新代码**（`lib/*` 是启动时 import 的）；客户端半刷新页面即可。
  两者版本错位是安全的：新客户端 + 老 host 会拿到 404，静静留着旧目录。
- 改法**不走这几条事件**时不会实时（例如绕过 DSH 直接手改配置文件、provider 那边远端模型自己变了）。
  这一条写进了 README 的已知限制。
- 真机端到端（在 GUI 里真的加一个模型、看弹层立刻出现）没做：宿主进程里跑的还是旧模块，
  而这次会话本身就跑在那个宿主里，重启会把会话带下去。

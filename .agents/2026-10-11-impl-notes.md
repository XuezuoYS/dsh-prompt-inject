# 实现记录与实测结论

按 [.agents/archive/2026-10-11-implementation.md](archive/2026-10-11-implementation.md)（任务书）落地后的记录。
规格以 `docs/` 为准，这里只写「怎么做的、验过什么、还差什么」。

## 交付物现状

```
dsh-prompt-inject/
├─ package.json          dsh.bundle.patch + dsh.client + engines.dsh + peerDependencies（官方包 exact 0.2.0-rc.2）
├─ cordis.patch.yml      - insert: [{ id: dsh-prompt-inject, name: dsh-prompt-inject }]
├─ icon.svg              currentColor 线性图标
├─ locale/{zh,en}.json   插件卡片显示文案（package.json.description 是中文，缺英文回退会出乱码，所以必须给）
├─ README.md             装法、配置、注入点位置、已知限制
├─ lib/
│  ├─ injectPoints.js    注入点表（键 / order / 官方段名 / 双语标签）
│  ├─ configStore.js     读写 ~/.dsh/dsh-prompt-inject/rules.json
│  ├─ configValidation.js POST /rules 的入参校验
│  ├─ ruleResolver.js    「注入点 + 模型键」→ 文本
│  ├─ modelRoute.js      「这轮算哪个模型」：官方模型选择投影优先
│  ├─ sessionInjector.js agent/pre-step 的注入与还原
│  ├─ systemSections.js  4 个中间段 + persona 头/尾（两个独立注入点）改写
│  ├─ settingsApi.js     GET /state、POST /rules
│  ├─ index.js           装配
│  └─ client.js          设置页（手写 bundle）
└─ .agents/checks/       验收脚本
```

## 实测结论（0.2.0-rc.2，本机 desktop 发行包）

### 1. `/api` 端点可用（阶段 0 的未知已消掉）

- `ctx.connection.fetch.register({ path, methods, requestBody, fetch })` 在桌面壳里正常注册与分发；
- 安装后 `cordis_inspect_query`（host `Config.listConfigs` / client `Slots.listSubTree`）能看到插件行 active、`settings.section` 多出 `promptInject` 占用者；
- 从 shell 直接 `Invoke-WebRequest` 打 `/api/...` 会 401：`/api` 的浏览器鉴权把无 token 的请求挡在外面，说明 `admit()` 那道门在生效。**浏览器里带上 token 的请求是否 200，只有页面本身能确认**，见下面「还没验的」。

### 2. 客户端半能被加载

- `window.__ModuleLoader__.load({ id: 'dsh-prompt-inject', factory })`，`exports.apply` + `exports.inject` 的形状与官方包一致；
- 注册进 `settings.section` 时只给 `id` / `order` / `label`（这几个是槽位声明的 registration 项）；
- `.agents/checks/client-shape.mjs` 用假的 `__ModuleLoader__` 跑通 factory 与 apply；
- `dsh.client.inject` 列了 `@deepseek-ai/dsh-client-ui-settings` 与 `@deepseek-ai/dsh-client-ui-primitives`（前者让声明槽位的行先到）。

### 3. 框架坑：范围替换会打脏派生消息缓存（**已用安全网兜住**）

`Session.deriveMessages()` 只有在 `derivedGeneration` 变化时才整体重建。范围替换（我们的还原动作）把 `derived` 数组清空、`surfaceGen` 加一，但 `derivedGen` 与 `derivedNodes` 还留在旧值：

```
替换前: nodes=1 derivedNodes=1 derivedGen=1 surfaceGen=1
替换后: nodes=1 derivedNodes=3 derivedGen=0 surfaceGen=1   ← derivedNodes 比节点数还大
```

此时**下一个读历史的人**（`buildRequest` 里的 `session.deriveMessages()`）会从 `slice(3)` 起算，直接漏掉历史。谁先读一次，谁就顺手把它修好了——所以「还原之后、挂新消息之前没人读过」是最危险的路径。

插件里的做法：`sessionInjector.repairDerivedCache(session)` 在还原完成后立刻调一次，发现 `derivedNodes > surface.nodes.length` 就强制重建。`.agents/checks/verify-derived-cache.mjs` 把两条路径都验了（9/9）。

**没有改 DSH 安装包**（那是用户的环境）；如果要根治，官方那边的改法是把 `derive()` 里的 `derivedNodes = nodes.length` 与 `derived = []` 一起在 generation 变化时重置。

### 4. 注入 / 还原的最终形状

- 前缀：`agent/pre-step` 返回 `[前缀, 原文, 后缀]`（`{ prepend: true }` 注册，`await next()` 之后再插入，插在认领到的用户消息两侧，保留下游 handler 追加的消息）；
- 工具循环：`decision.messages` 里没有 `source.kind === 'user'` → 什么都不做；
- 下一轮还原：**前缀**用一次范围替换换回原文；**后缀**单独成段抹掉（替换成空内容占位消息）；
- 每条注入消息在 `source.turn` 里带自己的轮次——原文是用户消息、拿不到 turn，靠这个区分「本轮」与「上一轮」，重启后也能正确判断。

调试过程中改过一次设计，值得记下来：最初按「从 surface 末尾往前找」配对前后缀，结果**只要这一轮调过工具**，后缀就夹在原文与助手回复之间，配对不上——工具轮之后注入会越积越多。现在改成扫描整张 surface，把属于更早轮次的注入分组，每组向右延伸到紧随其后的用户原文，逐组还原（还原与删除各自倒序执行，避免索引错位）。

### 5. system 段

- 4 个中间锚点：全局 `systemPrompt.section({ name, order, text(context) })`，order 950 / 3050 / 9800 / 10300；
- **persona 头与尾是两个独立注入点**（`system.personaHead` / `system.personaTail`，各一串规则），
  不再有 `system.persona` 那种 `head`/`tail` 嵌套形状：全局 `system-prompt/assemble` 监听器按
  `point.replaces` 把对应的官方段改写成解析出来的文本，没配的那一侧原样返回；
- 段文本含 `{{` 时给该段加 `interpolate: false`，避免官方当变量引用报错；
- section 是同步求值，所以 system 段保留一份配置快照，在「apply 启动 / 写成功 / `system-prompt/change`」三个时机刷新。

> 改过一轮：最初为了贴「官方把它当一个配置对」这件事，注入点做成了 `system.persona` + `head`/`tail` 的
> 二合一形状。用户反馈这会和「system 最末尾」这类描述打架、读起来别扭，于是全部拉平成 8 个同形状的
> 注入点。**没有任何特殊形状了**——`injectPoints.js` 里只有可选字段 `sectionName`（中间锚点）与
> `replaces`（改写官方段），其余全是「一串规则」。

### 6. 规则卡片的样子（改过两轮）

初版卡片把一个「文本摘要」当标题，加上模型键 chips：

```
⠿ [开关] 总是用中文回答   [全部] [编辑]
```

两个问题：摘要没有信息量（正文就在卡片里的输入框），而模型 chips 在选了多个模型时会把
`deepseek-account/deepseek-v4-pro` 这种长键拼成一行 —— 官方 `Tag` 是 `white-space: nowrap`，
于是 chips 撑爆卡片宽度，`flex` 把右侧按钮挤成「模型作用域/复制/删除」竖排一列。

第二轮又收了一版：

- 去掉标题/摘要；
- 模型结论只有三种：`全部` / `已应用 N 个模型` / `无应用`（失效另挂 `已失效 N`），
  做成**一枚可点的胶囊**——点它直接进作用域配置，具体键只在弹层里看；
- 上/下移动从左侧竖排条挪到**右侧按钮组**里，与复制/删除同排（`↑ ↓ │ ⧉ ✕`），头部从两行变一行，
  卡片高度少了一截；
- 动作改成 `primitives` 的图标组件 + `title` + `aria-label`（不再占文字宽度）；
- 删除做了**真的撤销**：删掉后 Toast 里点「撤销」会按**原来的位置**放回（`removeRule` / `restoreRule`）；
- 折叠小节的标题旁是枚数字胶囊（`2 条`），空的小节显示「还没有规则」；
- 样式补了 hover / focus-visible / active 状态，`保存中` 圆点会呼吸，动效统一 120ms，
  并在 `prefers-reduced-motion` 下关闭；正文输入框用自己的底色（`--dsw-alias-bg-base`）与聚焦环。

`.agents/checks/verify-card-render.mjs` 用一个「函数组件会被实际调用」的轻量渲染器，
断言卡片里出现哪种结论胶囊、不再出现模型键与文本摘要、右侧四个动作都在、点胶囊与点删除分别调到
哪个回调、以及 Toast 收到的 `actions` 里有没有「撤销」。所有 `--dsw-*` 变量都对着发行包审计过
（当场写个脚本扫 asar 里的 CSS/JS，确认每个变量名都有定义），14 个全部命中。

### 7. 修掉的坑（第三 / 第四轮）

**a. 有规则的小节收不起来。** 折叠状态原先只存「当前开着的那一个键」（`openPanelKey`），
渲染时又是 `openPanelKey === key || rules.length > 0` —— 只要这个注入点有规则，第二个条件永远为真，
点标题等于没点。改成 `panels: { [键]: boolean }` 的**显式覆盖表**：没点过就按默认（有规则展开），
点过就以用户为准。

**a′. 改完还是关不上（第四轮）。** 同一个功能连踩两次，原因不同，记下来：

1. 「当前是否展开」当成参数从视图传给控制器，而注入面是**逐个方法包一层转发**
   （`togglePanel: (pointKey) => controller.togglePanel(pointKey)`），多传的参数被丢掉，
   控制器永远收到 `undefined`，`undefined !== true` 恒真 → 每次都往「展开」翻。
   修法：控制器从**自己的快照**算当前状态，视图只传注入点键。
2. 首次加载是异步的：`apply` 时快照里 `slots` 还是空的，用户在第一帧点标题时，
   `rules.length > 0` 为假 → 明明有规则的小节被判成「收起」，再点一下反而变「展开」，
   看起来就像按钮反了。修法：判断默认值时用当前快照的规则（上面就是这么写的），
   并让测试**先等首次加载落地**再断言。

教训：**跨层传状态要传「事实」，不要传「视图对事实的解读」**；以及这种「点一次要翻两个状态」的
交互，必须有一个不依赖渲染层的回归测试。`verify-panel-toggle.mjs` 就是补上的那个：
它拿真实 `Controller`，按「点标题 → 发布快照 → 用新快照重渲染」跑，验证两种默认、来回点严格交替。

**b. `保存失败：slots.system.personaHead unknown injection point`。**根因不是新代码：浏览器里还挂着**拆分之前**的客户端 bundle（`system.persona` 那个二合一形状），
它把整个 slots 原样回传，里面带着服务端已经不认识的旧键，而校验层当时对未知键是**整包 422**。
两头都补了：

- host：`validateSlots` 认旧键 —— `system.persona.head/tail` 就地迁到
  `system.personaHead/personaTail`，其余未知键丢掉并记进响应的 `dropped`，**不再整包报错**；
  真正非法内容（规则字段、模型列表）照旧逐条 422。
- client：`sanitizeSlots()` 只挑本版本认识的键，加载和提交都过一遍，绝不再回传旧键；
  保存结果里如果带 `dropped`，提示写成「已保存（已忽略旧版本的字段：…）」。

**c. system 小节顺序与语义。** 页面原来把「头部 / 尾部」排在一起、中段排在后面，
和它们在 system 里出现的先后不一致。现在注入点表按落点顺序排：
`头部(0) → 工具之前(950) → 工具之后(3050) → 结构化输出之前(9800) → 尾部(10200) → 最末尾(10300)`，
并分组显示（用户消息 / system 段）。同时把「替换 / 插进」标出来：

| 注入点 | 语义 |
| --- | --- |
| 头部 / 尾部 | **替换**官方 `deployment:persona-prefix` / `-suffix` 段的文本（不能注册同名段，会被静默拒绝） |
| 4 个中段 + 最末尾 | **插进** `section()` 新段，落在声明的 order 上；不配就是空串，官方渲染直接丢掉 |

结论：**头尾是「替换」、中段是「插入」，两条路互不干扰，顺序也按 system 里的落点排。**

### 8. 其它踩到的点

- **`peerDependencies` 是链接式安装能跑起来的前提**，不是可选项：DSH 的解析层（`dsh-app-boot` 的 `routeLinked`）对「linked 插件」的裸导入是这样路由的——目标包必须在安装目录的解析表里，**并且某个祖先目录的 `package.json` 把该包列进了 `peerDependencies`**，才把请求路由到安装目录那一份。没有本地 `node_modules` 也能解析到官方包（离线按这条规则验过）。
- `writeFileAtomic` 的 `withFileLock` 需要父目录已存在（锁文件是 `<file>.lock`），写之前先 `mkdir`；
- `dsh-prompt-inject` 的 `package.json.description` 是中文，插件卡片读 `locale/en.json` 收英文；缺了会回退到中文（这里显示成乱码），所以补了 `locale/`；
- 仓库根 `package.json` 一旦有 `"type": "module"`，`.agents/archive/2026-10-11-asar-reader.js`（CommonJS）就再也跑不起来，得复制成 `.cjs` 跑；
- **别用 PowerShell 的 `Get-Content -Raw` / `Set-Content` 改这些源文件**：中文字符串会被写成乱码
  （`Set-Content -Encoding utf8` 也救不回来，读进来那一刻就已经错了）。改文件用 read/write/edit 工具，
  或者用 Node 的 `readFile`/`writeFile` 写个一次性脚本；
- 卡片里的图标按钮都用官方图标组件（`IconChevronUpOutlineRegular` 等），`icon` prop 接的是元素而不是字符串；
  文案必须留在 `title` + `aria-label` 上，否则图标按钮就没有可读名称了；
- 校验层放宽成「没给的注入点补空、persona 只给一侧合法」，页面只提交改过的那部分也能写回。

### 9. 还原逻辑改过一次（值得记）

最初按「从 surface 末尾往前找」配对前后缀。结果**只要这一轮调过工具**，后缀就夹在原文与助手回复之间，配对不上——前缀还原了、后缀留在历史里，且每一轮都会再积一份。现在改成扫描整张 surface：把属于更早轮次的注入节点分组，每组向右延伸到紧随其后的用户原文，逐组还原（还原与删除各自倒序执行，避免索引错位）。

### 10. 模型作用域串味：同 provider 的其它模型也被应用（第五轮，2026-10-12）

用户报：**配给某个模型的规则，同一个 provider 的其它模型也会被应用。**

根因不在匹配逻辑（`ruleApplies` 一直是精确 `list.includes`），而在「这轮算哪个模型」的判据：

- 老判据 `session.requestContext()` 是**最近一次已提交请求**的路由；
- 官方 agent loop 的顺序是「组装 system → `agent/pre-step` → `agent/request` → 落 `request/context`」，
  也就是说在这两条注入路径上，路由**还没解析出来**，读到的是上一个模型；
- 用户把会话从 A 切到同 provider 的 B，第一条请求按旧路由算 → A 的专属规则跟进到了 B。
  `agent.options` 也不救场：桌面端它是 `agentDefaultModel.currentSelection()`（**全局默认模型**），
  跟会话选的模型不是一回事；`dsh-agent` 的 `installModelSelection` 之所以在 `agent/request` 里覆盖它，
  就是为了这个。

官方真正的判据是**模型选择投影**：`ctx.sessionProjections.stateOf(session, 'modelSelection')`
（`@deepseek-ai/dsh-session-projection` 的对外读面，由 `@deepseek-ai/dsh-api-session-controller` 注册）。
桌面端点下拉走 Remote `session/selectModel` → `selectForNextRequest` → 落 `model/selection` 事件 + 置 `pending`，
所以：

| 投影字段 | 含义 |
| --- | --- |
| `pending` | 用户刚点、还没发出去的那个（切换的第一条请求就靠它） |
| `lastUsed` | 已经发出去过的最后一条路由（被匹配的 `request/header` 回收后 `pending` 置空） |

`dsh-agent` 的 `selection.current` / `selection.assembled` 就是这两个值的组合，所以插件算出来的模型
**和这次请求实际走的模型是同一个**。

改法（新模块 `lib/modelRoute.js`，两条注入路径共用）：

1. `modelKeyOfSession` → 投影 `pending` → `lastUsed`；服务缺失 / 键未注册 / `stateOf` 抛错都当没有（headless 组合不挂这个单元）；
2. 拿不到投影 → `session.requestContext()`（改造前行为，不会更糟）；
3. 再退 → `agent.options`；
4. system 段的头/尾改写多一层：`system-prompt/assemble` 的 `assembled.variables.provider/model`
   就是**这次组装**定下来的路由（官方自己写进去的），比任何回退都准，有就用它。

顺手对齐的两处：

- `/state` 的 `catalog.current`（页面顶部「当前模型」）改用同一条判据 → 显示的是「接下来这次请求」的模型，
  含刚切换还没发出去的那个；设置页顶部文案与 README 同步改了口径；
- 模型作用域弹层里给这一行挂一枚 `当前` 标签，一眼能看出这次请求按谁算。

回归测试 `.agents/checks/verify-model-route.mjs`（26 项，**不需要官方包**，纯 `node` 可跑）：
把「会话日志停在 flash + 投影说下一个是 other」构造成真机那一刻，断言 flash 专属规则不再跟进、
all 规则照旧、切回 flash 又生效；system 中间锚点的 `text(context)` 与 persona 头/尾改写也各有一组。
`verify-inject-flow.mjs` 末尾补了两项同场景的端到端（20/20）。

**查证手法值得留档**：会话日志 `~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd` 是**多帧拼接的 zstd**
（Node 的 `zstdDecompressSync` 只解第一帧，得按魔数 `28 B5 2F FD` 逐帧解），解开后能直接看
`model/selection` / `request/context` / `request/header` / 每条 `user/message` 的 `source.kind` ——
真机上到底注入了什么、当时算的哪个模型，一目了然。这轮就是靠它确认了本机 `deepseek-account/deepseek-flash`
一路正常，以及 `agent.options` 的语义。

## 验收状态

| 项 | 状态 |
| --- | --- |
| 逻辑 / 校验 / 还原判据（38 项） | ✅ `verify-logic.mjs` |
| 模型路由判据：投影优先、切换后不串味（26 项） | ✅ `verify-model-route.mjs` |
| 配置读写：坏文件自愈、revision 乐观锁、外部手改、原子写（20 项） | ✅ `verify-config-store.mjs` |
| host 接线：端点、/state、/rules、persona 改写（32 项） | ✅ `verify-host-wiring.mjs` |
| 注入全流程：注入 / 工具轮 / 还原 / 再注入 / 模型切换（20 项） | ✅ `verify-inject-flow.mjs` |
| 派生缓存危险路径与安全网（9 项） | ✅ `verify-derived-cache.mjs` |
| 客户端半形状 / 卡片渲染 / 折叠控制器 | ✅ `client-shape.mjs`、`verify-card-render.mjs`、`verify-panel-toggle.mjs` |
| 装进 desktop profile | ✅ `install_bundle`：`application: applied`，插件行 active，设置槽位出现 `promptInject` |
| 浏览器里的真实渲染与 `/api` 200 | ⬜ 只有页面能确认（要刷新一次页面） |
| 真机切模型后第一条请求的规则归属 | ⬜ 待用户换一次模型看一眼（日志里 `request/context` 与注入文本对得上就说明好了） |

## 还没验的

1. 浏览器刷新后设置页长什么样、`GET /api/dsh-prompt-inject/state` 是不是 200（shell 无 token，打不进去）。
2. 真机一轮的会话日志：`user/message` 的 append 真源、模型实际拿到的 `{前}原文{后}`、工具轮里只有一份。
3. 会话标题 / 压缩摘要这类「从日志派生历史」的内部调用看到注入后的表现（研究笔记里也列在未验项）。
4. 桌面壳与网页壳里 `/api` 鉴权行为是否一致。
5. **切模型后的第一条请求**：找个非默认模型发一条消息，用 `read-session.mjs` 看注入文本对不对得上 `CTX`——
   这是这轮修的 bug，逻辑与假环境都验过，真机只差你点一下。

## 临时文件

写码期间在仓库根目录用过几个一次性工具（读 asar、抽官方包到临时实验目录、审计样式变量、
改文档），**交付前已全部删除**；`.agents/checks/README.md` 里留了重建步骤与要抽的包清单。
临时目录 `$TEMP\dsh-pi`（asar 读取器 + 抽出来的官方包 + 会话日志副本）、`$TEMP\dsh-pi-exp`
与各次跑测试留下的 `$TEMP\dsh-prompt-inject-home-*` 都已清理；仓库根不留 `node_modules`。

留在 `.agents/checks/` 的只有长期有用的东西：验收脚本，以及 `read-session.mjs`（查真机会话日志的探针，
这次定位模型路由问题就靠它）。

# 2026-10-11 · DSH 注入点调研笔记

正式产出（冲突时以 docs 为准）：

- [docs/injectPoint.md](../../docs/injectPoint.md) —— 注入点与机制
- [docs/injectScopeAndSetting.md](../../docs/injectScopeAndSetting.md) —— 配置模型（用户维护）
- [docs/settingGUI.md](../../docs/settingGUI.md) —— 设置界面实现
- [docs/injectFormat.md](../../docs/injectFormat.md) —— 注入格式（用户维护）

调研对象：DeepSeek Harness **0.2.0-rc.2**（本机 desktop 发行包）。
这份笔记放的是**从 docs 下沉的理由、备选方案、实验记录和源码索引**，docs 里只留规范。

## 怎么拿到官方实现

DSH 发行包把代码打进 `app.asar`，磁盘上没有源码目录。

1. 归档位置：Windows 桌面版默认在 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar`
   （同目录的 `app.asar.unpacked` 只有原生模块；自定义安装目录就以实际路径为准）
2. 读取脚本：`node .agents/archive/2026-10-11-asar-reader.js <list|tree|cat|extract> <archive> <前缀> [输出目录]`
3. 只解需要的包（全量约 2911 文件 / 52 MB，用完就删）：

   ```powershell
   $asar = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app.asar"
   node .agents/archive/2026-10-11-asar-reader.js extract $asar "dsh/node_modules/@deepseek-ai" ".agents\dsh"
   ```

   归档内逻辑路径：`dsh/node_modules/@deepseek-ai/<包名>/lib/index.js`；
   `dsh/package.json` 有完整包名与版本清单。

## 架构背景：四个决定一切的事实

1. **模型看到的东西 100% 由会话日志推导。** agent loop 每个 step 调 `session.deriveMessages()`，
   按 surface 节点顺序取消息。请求对象 `Object.freeze` + 深冻结，官方在 `llm/stream` 文档里写明：
   loop 请求是会话日志的纯函数，监听者只能读不能改。
2. **聊天记录只认 append，替换只影响模型。** 官方原话：模型可见的 surface 会遮蔽被替换的区间，
   「所以它不能当人类聊天记录的来源……append 事件才是聊天记录的真源，替换副本只留在模型侧」。
   Chat 客户端的 `user/message` 判定就是 `isAppendSurfaceEvent(event)`。
   → 这是「用户气泡不被污染」和「还原后聊天记录不变」的根据。
3. **客户端按 `source.kind` 决定怎么画。** `kind === "user"` 才是用户气泡，其它一律画成上下文行
   （带 kind 标签，`form` 取值 `instructions`/`catalog`/`snapshot`/`notice`/`relay`/`recall` 决定样式）。
   → 插件注入的 user 消息天然不会污染用户气泡。
4. **append 不可重入。** `Session.append` 期间再 append 直接抛错，
   而 `session/event` 通知是在 append 内部同步发出的 → 「消息落库后立刻补一条替换」做不到，
   前后缀必须是独立消息。

## 已核实的事实（都有出处，不是推测）

第一轮（system + 注入位置）：

- system 是一条 `role:"system"` 的消息，固定 surface 第 0 节点；adapter 把它提到请求的 `system` 字段。
- 官方头尾 = `deployment:persona-prefix`(order 0) / `deployment:persona-suffix`(order 10200)，同一配置对管两头 → 标「二合一」。
- `systemPrompt` 服务四个注册口：`section` / `context` / `variable` / `tools`，外加 `system-prompt/assemble` waterfall。
- 官方 API 目录在 `@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js`，查事件签名先看它。

第二轮（按 injectFormat 核对）：

- DeepSeek adapter 会把连续 user 消息合并成一条（前缀/原文/后缀三段连排即成 `{前}原文{后}`）；pi-ai adapter 不合并。
- 空 user 消息在推导时不会被丢弃（`user/message` 没有空内容检查）；DeepSeek 序列化时跳过，pi-ai 会发空串。
- `llm/stream` 的 loop 请求深冻结；官方要求只读，但契约允许「yield 自己的 chunk 短路」。
- `request/header` 落库时显式禁止 `header.system`（抛错）；`config.system` 能漏过去，但明显是漏网，不推荐。
- DeepSeek 的请求字段扩展注册表（`dsh-deepseek-llm-api-extensions`）只收新字段，撞上 `messages`/`system` 会抛错。
- profile 解析层会把插件里 `@deepseek-ai/*` 的裸导入路由到安装目录（scope: installation），
  **前提是声明成 peerDependencies**；本地依赖会导致两份模块（WeakSet / instanceof 失效）。

第三轮（客户端 UI 面）：

- 设置页的扩展槽位是官方 `dsh-client-ui-settings` 声明的 `settings.section` / `settings.plugins.tab` / `settings.onboarding`。
- 槽位「声明即独占」：注册未声明的槽位、或自己声明已被别人声明的槽位，加载时报错。
- 官方 `settings` 表单是**投影 Cordis 配置**的（编辑 loader 里的 volatile 字段并写回 profile patch），
  塞不下「规则列表 + 每条模型多选」，所以自带页面更合适。
- 插件自带 GUI 的正路是 `package.json` 声明 `dsh.client = { platform: 'web' }`，宿主 compose 成 `/plugins` bundle；
  现存第三方挂件 `dsh-whale-widget` 走的是「往 index.html 塞 script + 自建路由」的老路，不用学。
- 版本兼容声明用 `engines.dsh`（`dsh-package-manifest`），plugin-manager 安装时会校验。

## 备选路线与取舍（user 前后缀）

| 路线 | 做法 | R1 wire | R2 历史干净 | R3 UI 干净 | 结论 |
| --- | --- | --- | --- | --- | --- |
| A 请求层改写 | `llm/stream` 里另造请求并重发一次 | ✓ | ✓ | ✓ | **不采用**：官方明确要求 loop 请求只读，要自己防重入、自己判断 loop 请求（`isAgentLoopRequest` 是模块私有 WeakSet），跨 rc 最容易碎。留作 R3 收紧时的备选 |
| **B 日志注入 + 还原** | `agent/pre-step` 插三条、下一轮范围替换还原 | ✓ | ✓ | △（聊天记录留两张上下文卡片） | **采用**：全官方 API，跨版本风险低 |
| C 只注入不还原 | 官方 `systemPrompt.context` 的做法 | ✓ | ✗ | △ | 不采用：历史会一直累积前后缀 |

R1 = 当前轮 wire 上是 `{前}原文{后}`；R2 = 只有当前轮带前后缀；R3 = UI 永远显示原文。

## 已定方案

- user 前后缀走**路线 B**：每轮只注入一次、整轮保持、下一条用户输入到来前用一次范围替换还原。
- 还原点**故意不放在 `agent/turn-stopping`**：那个事件可能被 Stop hook、模型切换提示续命（续命后还在同一轮），
  在那儿还原会破坏「保持到本轮结束」。放在「下一条用户输入到来前」最稳。
- system 头尾用**全局 `system-prompt/assemble` 监听器改写**（原因见下面实验记录），中间锚点用全局 `section()` + 函数式 `text`。
- 「二合一」：注入列表里一项，设置页拆成头/尾两块，插件当同一注入点处理，有规则的一侧改写、没规则的一侧不动。
- 配置目录 `dshHomePath('dsh-prompt-inject')`（`@deepseek-ai/dsh-home-paths`，内部 `$DSH_HOME` → `~/.dsh`），
  宿主唯一写者，`dsh-atomic-write` 原子替换。
- 已知代价：聊天记录里每轮多两张 `prompt-inject` 上下文卡片，替换删不掉。

## GUI 设计取舍

- **页面位置**：设置导航里独立一项（`settings.section`），导航名直接用插件名 `dsh-prompt-inject`，不做翻译。
  （另一个候选是塞进 Plugins 页的 tab，入口更深，放弃。）
- **数据通道**：不用官方 typert Remote —— 那条路要 `lib/typert.host.js` + `lib/typert.remote-client.js` 两个生成产物
  （协议包写明「反射是构建管线的活」，生成器 `@deepseek-ai/dsh-typert-generator` 只发 npm，运行时不带）。
  改用 `ctx.connection.fetch.register`：`/api` 是官方连接层的 prefix 路由，请求先过 `admit()`
  （Host/Origin 校验 + 浏览器鉴权）才轮到我们，鉴权白送；代价是方法只有 `GET | HEAD | POST`。
  另外也没选自建 `webServer` 路由——那样鉴权得自己写。
- **排序**：先做上/下移动按钮（官方 UI 库没有拖拽原语），拖拽留作后续。
- **保存**：500ms debounce 自动提交 + `revision` 乐观锁；不做显式保存按钮。
- **模型作用域**：`全部` 与各模型同列；点「全部」不清空其它勾选（取消后原选择继续生效）；
  失效模型置灰标「已失效」、保持勾选等用户取消，取消前按不匹配处理，host 侧同一套规则。
- **预览区**（未定）：客户端把启用规则按顺序连起来就能显示「当前模型下最终拼成什么」，实现便宜但页面会长。

## 验证实验（2026-10-11）

脚本：同目录的 `2026-10-11-verify-*.mjs`（4 个）。运行方式：先把官方包解到 `.agents/exp/node_modules/@deepseek-ai`
（注意要落到 `node_modules` 层级，见文首命令 + 移动一步），脚本放在 `.agents/exp` 同级再 `node` 跑。
全部只加载官方包，**不碰正在用的 DSH 配置**；跑完已清理（52 MB）。

| 脚本 | 验证内容 | 结果 |
| --- | --- | --- |
| `verify-assemble-waterfall.mjs` | 同一作用域重名段；全局 waterfall 改写 persona | 重名被静默拒绝；waterfall 改写/插入可用、实时、只影响本作用域 |
| `verify-mount-timing.mjs` | 行插件挂载时序；自己的段名 + order | 挂载**异步**（一 tick 后才生效）；自己的段名按 order 正确插入 |
| `verify-global-per-agent.mjs` | 全局注册 + 函数式 text + waterfall 能否按 agent/模型区分 | 可以；未配规则时官方默认原样保留 |
| `verify-surface-replace.mjs` | 路线 B：三段连排 → 整轮保持 → 范围替换还原 | 全部通过；`sourceEventSeqs` 必须列全；逐条空替换会留空节点 |

关键实测结论：

- 作用域 ctx 上**不能**直接 `agentCtx.systemPrompt.section(...)`（`cannot get property … without inject`）。
- 同一作用域再注册与官方 `dsh-persona` 同名的段会被**静默拒绝**（fiber 进失败态，不抛给调用方）
  → persona 头尾必须走 `system-prompt/assemble` 改写。桌面 agent preset 本来就挂了 `dsh-persona`，所以这条路是真堵死的。
- 全局 `section()` + 函数式 `text`，配合全局 `system-prompt/assemble`，就能按 `context.agent` 区分会话与模型，
  且不需要按 agent 挂载（行插件是异步生效的，按 agent 挂还有时序问题）。
- 路线 B 的动作链在真实 Session 上跑通：`[前缀][原文][后缀]` 落库 → 范围替换回一条原文 → append 真源不丢。

## 源码索引

| 包 / 文件 | 关键内容 |
| --- | --- |
| `dsh-system-prompt/lib/index.js` | `SECTION_ORDERS`、`SystemPrompt`（`section`/`context`/`variable`/`tools`/`assemble`）、`renderPrompt`、persona 段名常量 |
| `dsh-agent-loop/lib/index.js` | `preStep()`（`agent/pre-step` 派发点）、`step()`（system/user 消息落库）、两个 Projection、`buildRequest()` |
| `dsh-agent/lib/index.js` | `assembleContextFor()`、`installModelSelection()`（`agent/pre-step` + `agent/request` 的官方范例） |
| `dsh-persona/lib/index.js` | persona 行插件：`prefix` / `suffix` / `complete` |
| `dsh-llm/lib/index.js`、`lib/types/call-config.js` | `LlmRuntime.stream()`（`llm/stream`）、`markAgentLoopRequest` / `isAgentLoopRequest`（模块私有 WeakSet） |
| `dsh-llm-deepseek/lib/index.js` | `serialize()`：连续 user 消息合并、system → `system` 字段 / in-history、空 user 跳过、请求字段扩展注册表 |
| `dsh-llm-pi-ai/lib/index.js` | `splitSystemPrompt()`：`options.system` 一有值，历史 system 消息会折叠成 user |
| `dsh-session/lib/index.js` | surface 折叠、`deriveMessages()`、`isAppendSurfaceEvent`、append 重入保护、system 第 0 节点保护 |
| `dsh-compaction-basic`、`dsh-compaction-tool-result-pruner` | 官方用 `surfaceOp.replace` 改历史的范例 |
| `dsh-client-ui-chat/lib/client.js` | `messageDefinition`（按 `source.kind` 分流）、`KNOWN_FORMS`、`isAppendSurfaceEvent` 过滤 |
| `dsh-client-ui-trajectory/lib/client.js` | Trajectory 不过滤替换事件，看到的是模型真实历史 |
| `dsh-client-ui-slots/README.md` | 槽位模型；注册未声明槽位 / 重复声明会报错 |
| `dsh-client-ui-settings/README.md` | `settings.section` 等槽位；`ctx.configForms` 是投影 Cordis 配置的 |
| `dsh-client-ui-settings-general/lib/client.js` | 官方 section 注册范例（`id`/`order`/`label`/`children`） |
| `dsh-client-connection/lib/index.js` | `/api` 路由：先 `admit()` 再分发；`registerFetchRoute` 要求路径在 `/api` 下 |
| `dsh-typert-protocol/README.md` | `@Remote` 声明 + 「反射由构建管线完成」＝需要生成产物 |
| `dsh-tool-cordis/lib/types/api-catalog.js` | 官方 API 目录；`key: 'connection'`、`ConnectionFetchMethod`（只有 GET/HEAD/POST） |
| `dsh-client-modules/README.md` | `dsh.client` 声明与 `/plugins` bundle |
| `dsh-home-paths/lib/index.js` | `dshHomePath()` |
| `dsh-client-ui-primitives/lib/*` | Button / Switch / Input / Modal / Tag / Toast 与 `--dsw-*` 设计变量 |
| `dsh-base/cordis.patch.yml`、`dsh-web-app/cordis.patch.yml`、`dsh-web-app/presets/*.patch.yml` | system-prompt 与 persona 的默认配置 |

## 本地验证手法

- system：监听 `system-prompt/assemble`，对 assembly 调 `renderPrompt()` 打印；或读日志 `system/message`。
- 每轮消息：读日志 `user/message` 事件顺序，或监听 `session/event`。
- 真实请求：临时监听 `llm/stream` 打印 `options.messages`（只看不改）。
- 现成对照：本会话 system 首行 `harness:identity`、次行 personaPrefix、末行 personaSuffix；
  用户消息后那条 `Current runtime context…` 是动态上下文注入。

## 还没验证的

- **真实 DSH 里**跑一遍上面四个实验的等价动作：范围替换的 `sourceEventSeqs`、带图消息替换是否合法、
  工具循环请求里前后缀是否只有一份且没被撤、`agent/created` 时机、DeepSeek in-history 的 system 追加行为。
- `ctx.connection.fetch.register` 的端点在**桌面壳与网页壳**里行为是否一致（`/api` 鉴权两处都要通）。
- 还原的兜底：靠扫描 `source.kind` 找残留，跨进程重启后能否自愈。
- 注入存活期间，会话标题 / 压缩摘要这类「从日志派生历史」的内部调用会不会看到前后缀。
- 上下文卡片的显示效果与文案（现在只有一个 kind 标签）。
- 外部 hook（`UserPromptSubmit`）只确认了桥接路径，配置文件查找顺序没验证。

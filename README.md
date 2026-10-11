# dsh-prompt-inject

给 DeepSeek Harness（DSH）的插件：在设置页按**注入点 → 多条规则**配置发送时注入的前后缀与 system 文本，规则可以启用/排序，并且可以只对指定的模型生效。

面向 DSH `0.2.0-rc.2`。

## 装什么、怎么装

一个 npm 包，两半：

- **host**：`lib/index.js`，持有规则文件、注入逻辑、`/api` 端点；
- **client**：`lib/client.js`，设置页（手写 bundle，不走构建链）。

依赖全部声明成 `peerDependencies`（`@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis`），由 DSH 安装目录提供，不要装成本地依赖——那会出现两份模块，`instanceof` 与模块私有 WeakSet 都会失效。

安装（桌面版 GUI 里宿主进程没有 `dsh` CLI，用插件管理器最省事）：

- 让 Agent 调用 `plugin_manager` 的 `install_bundle`，target 填本目录绝对路径；或
- GUI「设置 → 插件」页用本地路径安装。

装完确认：

1. `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里出现 `dsh-prompt-inject`；
2. 设置导航里出现 `dsh-prompt-inject` 一项；
3. 改 `lib/client.js` 刷新页面即可（插件管理器按文件 mtime 给 bundle 打修订号）。

**改了 host 半（`lib/index.js`、`lib/sessionInjector.js` 等）怎么让运行中的 DSH 用上新代码**：

- `install_bundle` 对**已安装**的插件只会回 `restart-required`，不会重新加载模块；直接重装等于白装。
- 想让不重启就生效：用插件管理器的 `set_plugin` 先把该条目**禁用再启用**（一次真正的 HMR 重载，
  会清掉 ESM 缓存重新 import）。条目 id 形如 `include:dsh-prompt-inject`。
- 也可以重启 DSH（托盘的退出后重开），最稳。

卸载：`plugin_manager` 的 `remove_bundle`，或在插件页里移除。禁用后 DSH 行为回到装之前。

## 怎么配

打开**设置 → dsh-prompt-inject**，分成几个注入点，每个注入点下是一串规则：

| 注入点 | 落在哪里 | 语义 |
| --- | --- | --- |
| 用户前置词 | 当前用户输入**之前**（独立的一条 user 消息） | 插入 |
| 用户后置词 | 当前用户输入**之后** | 插入 |
| system 头部 | 官方 persona 段的头（`deployment:persona-prefix`，order 0） | **替换**官方那段 |
| 工具说明之前 | system 段位 order 950 | 插入新段 |
| 工具说明之后 | order 3050 | 插入新段 |
| 结构化输出之前 | order 9800 | 插入新段 |
| system 尾部 | 官方 persona 段的尾（`deployment:persona-suffix`，order 10200） | **替换**官方那段 |
| system 最末尾 | order 10300（排在官方 persona 尾之后） | 插入新段 |

设置页就按**上面这个顺序**排（也就是它们在 system 里出现的先后），头与尾不挨着；每个 system 小节带一枚
`替换` / `插进` 标签，一眼能看出它会不会动到官方内容。

- **替换**（头 / 尾）：官方那两段本来就是 deployment 的 persona 配置。插件**不注册同名段**（会被官方静默拒绝），
  只在组装阶段把已有那一段的文本换掉；不配就原样返回。
- **插入**（4 个中段）：官方没有对应段落，插件用 `systemPrompt.section({ name, order })` 新加一段；
  不配（解析为空串）时官方渲染会把它丢掉，等于不存在。所以「插入」不会覆盖任何官方段。

**八个注入点形状完全一样**：都是一串规则。

每条规则：

- **顺序**：卡片右侧的 ↑ / ↓ 图标按钮；同一注入点内从上到下拼接，规则之间空一行。
- **启用开关**：关掉就不参与拼接，但还留在列表里。
- **文本**：多行输入框，是卡片唯一的主体（不另做标题/摘要）。正文里可以写**模板字段**（`{{model}}` / `{{provider}}` / `{{cwd}}`），发送时换成这次请求的真实值；其余 `{{...}}` 原样保留，写错了只会当字面文本，不会报错。见下面的「模板字段」。
- **模型作用域**：卡片上是一枚**可点的结论胶囊**（点它就进配置），具体勾选在弹层里看。
  - 胶囊只会有三种：`全部` / `已应用 N 个模型` / `无应用`（失效的另挂一枚 `已失效 N`；`无应用` 用虚线圈出）；
  - 弹层里勾「**全部**」= 对所有模型生效（含以后新增的）；
  - 勾「全部」**不会**清空其它勾选；取消「全部」后，之前勾的模型继续生效；
  - **没勾「全部」也没勾任何模型 = 这条规则不生效**，胶囊显示「无应用」并给一句轻提示；
  - 存的模型在当前目录里找不到 → 置灰标「**已失效**」，保持勾选等你自己取消；取消前按「不匹配」处理（不注入）。
  - 「算哪个模型」以**官方的模型选择投影**为准（就是你在下拉里点的那个，含刚切换、还没发出去的），
    所以配给 A 的规则不会因为你切到同 provider 的 B 而跟进到 B 的第一条请求上。
- **复制 / 删除**：右侧的 ⧉ / ✕ 图标按钮；删除后会弹一条提示，点里面的「撤销」会把规则**放回原来的位置**。
- **折叠**：每个注入点是一个可折叠小节，有规则的默认展开，点标题就能收起来（收起来的状态会记住）。

保存是自动的：改完 500ms 内提交，顶部显示「保存中 / 已保存 / 保存失败」。两个窗口同时改时，后提交的那个会收到 409，界面提示并载入最新值，不会静默覆盖。

## 模板字段

规则的正文里可以写官方的提示词变量，发送时换成这次请求的真实值。设置页每个注入点展开后有一行字段徽章（点一下插到光标处），下面是注释：

| 字段 | 换成什么 |
| --- | --- |
| `{{model}}` | 这次请求实际用的模型 id，如 `deepseek-flash` |
| `{{provider}}` | 模型属于哪个 provider，如 `deepseek-account` |
| `{{cwd}}` | 当前会话的工作目录绝对路径 |

- 这三个就是官方 persona 头尾用的变量（官方头 `You are a coding agent powered by the {{model}} model.`、官方尾 `Your working directory is {{cwd}}.`）。
- **前后缀**在注入那一刻渲染成成品（注入永久保留，字段之后就定死了）；**system 段**在每次组装时渲染，渲染完不再交给官方插值器。
- 认不出、或这次取不到值的字段**原样保留** `{{名字}}`，不报错；拼错的小写字段在卡片里给一条轻提示。细节见 [docs/injectFormat.md](docs/injectFormat.md)。
- 字段表是**静态白名单**（官方桌面部署注册的变量就这三个），不反射官方注册表：别的插件自己注册的变量插件不认，会原样保留。

规则文件在 `~/.dsh/dsh-prompt-inject/rules.json`（host 是唯一写者）。文件坏了或版本不认时，会被改名成 `rules.json.<时间戳>.bad` 保留现场，然后用空配置继续跑——不会静默清空你的配置。

## 注入是怎么发生的

### 用户前后缀

- 一轮只注入一次：模型认领到你的消息时，在它前后各插一条独立的 user 消息，`source.kind` 是 `prompt-inject`；
- **整轮保持**：这一轮的工具调用请求不新增注入，本轮那份留在历史里；
- **永久保留**：注入之后就不再动它了——下一轮不会把「前缀 + 原文 + 后缀」整段还原回你的原文，也不会清除。
  注入消息就作为一条普通的上下文块，一直留在会话历史里，一轮轮累积；
- 你**自己那条消息永远不改**，它是聊天记录的真源；所以 UI 里用户气泡始终是原文，
  多出来的是带 `prompt-inject` 标签的上下文卡片。

**已知的小代价**：上一轮的后置词会一直留在历史里，夹在「上一轮原文」和「下一轮用户输入」之间——
模型的视角里那就是「用户后来又补充了一句」。这是「保留注入、不自动清理」这个选择换来的，属正常现象，不是 bug。

对 DeepSeek 适配器来说，连排的三条 user 消息会被合并成一条 `{前置词}原文{后置词}`；pi-ai 那类不合并的适配器就是三条。

### system

- 4 个中间锚点是全局注册的 `systemPrompt.section()`，文本按 `context.agent` 现场求值；
- 头部与尾部走全局 `system-prompt/assemble` 监听器**改写官方那一段**（各自独立），因为桌面 agent preset 已经挂了官方 `dsh-persona`，同一作用域重名注册会被静默拒绝；
- **全都不配时，system 与装插件前逐字一致**。

## 已知限制

- 设置页**不显示「当前模型」**：多会话并行时最近活跃会话未必是你正在看的那个，切换也未必及时反映，显示出来只会误导；顶部只留保存状态。规则按 `provider/model` 匹配，看卡片上的作用域结论或弹层即可。
- 规则按 `provider/model` 匹配。模型目录拉不到的 provider 会被跳过并提示，此时只影响展示（已存的键会显示成「已失效」），不影响其它 provider 的规则。
- 版本声明用精确版本 `0.2.0-rc.2`。DSH 升级后如果插件管理器报 `incompatible-version`，把 `package.json` 里 `peerDependencies` 的 `0.2.0-rc.2` 与 `engines.dsh` 一起改成新版本即可；也可以放宽成 `>=0.2.0-rc.2 <0.3.0`（把 `includePrerelease` 语义交给官方校验），但要自己承担跨小版本接口变化的风险。
- 暂不支持：注入点内拖拽排序（用 ↑ / ↓）、「当前模型下最终拼成什么」的预览区。

## 开发

```powershell
# 语法检查
node --check lib/client.js

# 不需要官方包，直接跑
node .agents/checks/client-shape.mjs
node .agents/checks/verify-template-fields.mjs
node .agents/checks/verify-card-render.mjs
node .agents/checks/verify-panel-toggle.mjs
node .agents/checks/verify-model-route.mjs

# 需要 DSH 官方包：先按 .agents/checks/README.md 搭一份 node_modules
node .agents/checks/verify-logic.mjs
node .agents/checks/verify-config-store.mjs
node .agents/checks/verify-host-wiring.mjs
node .agents/checks/verify-assemble-render.mjs
node .agents/checks/verify-inject-flow.mjs
node .agents/checks/verify-inject-persistence.mjs
node .agents/checks/verify-derived-cache.mjs
node .agents/checks/verify-timeline.mjs
```

> `verify-logic.mjs` 测的 `planRestore` 是**纯判据**：当前版本「注入永久保留、不还原」，
> 生产路径已经不调用它，判据与测试保留是为了将来若要把「自动清除」重新做成选项时不必从零写。

代码只依赖官方公开接口：`connection.fetch.register`、`systemPrompt.section`、`system-prompt/assemble`、`agent/pre-step`、`llm.listProviders/listModels`、`session.append/deriveMessages/surface/eventAt`，加 `dsh-home-paths` 与 `dsh-atomic-write`。设计依据与实验记录见 `.agents/`。

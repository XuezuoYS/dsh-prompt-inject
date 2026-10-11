# .agents/checks 怎么跑

这些脚本只用来验收插件，不属于交付物。分两类。

## 一、直接 `node` 就能跑（不 import 官方包）

| 脚本 | 检查什么 |
| --- | --- |
| `client-shape.mjs` | 客户端半的 `__ModuleLoader__` 注册形状、`settings.section` 注册项、`inject` 声明、**订阅的「目录失效」事件与 host 表逐字一致**（另加 `connection/reset`） |
| `verify-template-fields.mjs` | **模板字段纯逻辑**：字段表、`{{字段}}` 替换规则（认不出/取不到值/名字不合规则一律原样保留）、agent 取值与组装期合并 |
| `verify-card-render.mjs` | 规则卡片的实际渲染：结论胶囊（全部 / 已应用 N 个模型 / 无应用 / 失效）、不再有标题与模型键、右侧四个图标动作、点胶囊与点删除分别调到哪个回调、Toast 的「撤销」动作、分组与 system 顺序、替换/插进标签、模板字段徽章与点击插入、拼错字段的轻提示 |
| `verify-panel-toggle.mjs` | **控制器级**折叠回归：用真实 `Controller` 走「点标题 → 发布快照 → 重渲染」，验证有/无规则两种默认、来回点严格交替、各注入点互不影响、提交的 payload 只含已知键 |
| `verify-model-route.mjs` | **模型路由回归**：官方的模型选择投影（pending → lastUsed）压过「最近一次已提交请求」，切换模型后 A 的专属规则不会跟进到 B；投影缺失时的回退链；system 中间锚点与 persona 头/尾改写都按同一条判据走 |
| `read-session.mjs` | 真机探针：把会话日志（多帧 zstd）解成「路由 / 注入 / 用户消息」时间线，核对这轮算的哪个模型、实际注入了什么 |
| `verify-inject-persistence.mjs` | **回归（当前行为）**：多轮跑真实 SessionStore，断言注入**永久保留**、一轮轮累积（第 N 轮就是 N 条）、顺序是「PREFIX → 该轮原文 → SUFFIX」、工具循环不重复注入、历史里不再有空占位 |
| `verify-timeline.mjs` | 时间线复刻：多轮打印每轮模型实际看到的消息，肉眼核对注入落位 |

```powershell
cd D:\0-code-project\dsh-prompt-inject
node .agents/checks/client-shape.mjs
node .agents/checks/verify-template-fields.mjs
node .agents/checks/verify-card-render.mjs
node .agents/checks/verify-panel-toggle.mjs
node .agents/checks/verify-model-route.mjs
```

`read-session.mjs` 是查真机用的探针（不 import 任何包）：把会话日志 `.jsonl.zstd` 解成时间线，
一眼看到每轮 `CTX`（已提交的路由）/ `SEL`（用户点下拉）/ `HDR` 与每条注入消息：

```powershell
node .agents/checks/read-session.mjs "$env:USERPROFILE\.dsh\sessions\--D-0-code-project-dsh-prompt-inject--\session-xxxx\session.v4.jsonl.zstd" 摘要
```

> 日志是**多帧拼接**的 zstd（每次 append 一帧），Node 的 `zstdDecompressSync` 只解第一帧，
> 所以要按魔数 `28 B5 2F FD` 逐帧解——这个脚本里就是这个做法。

## 二、需要官方包（`@deepseek-ai/*`）

`verify-logic.mjs`（要 `dsh-llm` 系）、`verify-config-store.mjs`、`verify-host-wiring.mjs`、
`verify-inject-flow.mjs`、`verify-derived-cache.mjs`、`verify-assemble-render.mjs`、
`verify-catalog-refresh.mjs`、`verify-catalog-events.mjs` 都要 import 官方包
（`@deepseek-ai/cordis`、`dsh-session`、`dsh-llm`、`dsh-atomic-write`、`dsh-home-paths`、`dsh-system-prompt`、`dsh-api-remotes` 等）。
`verify-assemble-render.mjs` 是**真官方 SystemPrompt + 真 `renderPrompt`** 的集成回归：模板字段落位、
没配改写的官方段仍由官方插值、没有 agent 时不炸、全不配时逐字不变。

**模型目录实时刷新**那两件：

- `verify-catalog-refresh.mjs`（**客户端半**）：用假宿主 + 真 `Controller` 走一遍——推送来了就重拉 `/catalog`、
  连推三条只合并成一次、**只换目录**（规则 / revision /「保存中…」都不动）、拉失败留旧目录、
  老 host 回 404 也不炸；第二段用**真 cordis** 验「`remote` 服务晚挂上也能补上订阅」。
- `verify-catalog-events.mjs`（**host 半**）：先核官方白名单 `API_REMOTE_FORWARDED_EVENTS`
  （名字不在里面 = 永远收不到推送），再用**真 cordis**（官方服务用替身）把四条事件各推一次，
  断言目录缓存当场失效、并且插件停用后监听器与端点一起消失。

DSH 发行包把官方包放在 `app.asar` 里，磁盘上没有，所以要临时抽一份出来。

**临时搭法**（把发行包里的 `dsh/node_modules` 整棵抽出来 + 在仓库根挂个 `node_modules` 链接；跑完都删掉）。
整棵抽 105 MB 左右，但一次搞定，不用一个个列包名：

```powershell
$asar = "C:\Users\xuezu\AppData\Local\Programs\DeepSeek Harness\resources\app.asar"
$exp  = "$env:TEMP\dsh-pi\exp2"

# 现场写一个 asar 读取器（`.cjs`），把整棵 node_modules 抽出来
node <asar 读取器>.cjs extract $asar "dsh/node_modules" $exp

# 让仓库里的脚本也能解析这些包
New-Item -ItemType Junction -Path .\node_modules -Target "$exp\dsh\node_modules"

node .agents/checks/verify-logic.mjs
node .agents/checks/verify-config-store.mjs
node .agents/checks/verify-host-wiring.mjs
node .agents/checks/verify-catalog-events.mjs
node .agents/checks/verify-catalog-refresh.mjs
node .agents/checks/verify-assemble-render.mjs
node .agents/checks/verify-inject-flow.mjs
node .agents/checks/verify-inject-persistence.mjs
node .agents/checks/verify-derived-cache.mjs
node .agents/checks/verify-timeline.mjs

# 清理
Remove-Item .\node_modules -Force
Remove-Item $exp -Recurse -Force
```

> asar 读取器现场写一个就行（`.cjs`，用 `fs.readSync` 读 `[u32=4][u32=headerSize][...][u32=jsonLen][json]`
> 头部再按 `entry.offset` 取文件）；或者用 `.agents/archive/2026-10-11-asar-reader.js` 的内容复制成 `.cjs`。
> 直接 `node` 跑那个 `.js` 会失败：仓库根 `package.json` 是 `"type": "module"`，`.js` 会被当 ESM。
>
> **安装包的坑**：这份发行包的 asar 数据区起点是 `16 + pickledSize - 8`，不是官方 reader 的
> `16 + pickledSize`；用后者会把每个文件的开头吃掉 8 字节。现成可用的读取器在
> `.agents/archive/asar2.cjs`（`list` / `read` / `extract` 三种用法）。
>
> **解析的坑**：官方包的相互引用（如 `cordis` 引 `@deepseek-ai/cosmokit`）要求包目录真的位于
> 某个 `node_modules/@deepseek-ai/` 下面，所以抽出来之后要在该目录里再给每个包做一层 junction，
> 再把仓库根的 `node_modules/@deepseek-ai` 指过去，脚本才 import 得动。
>
> 插件自己在运行时**不需要**这份 `node_modules`：它把 `@deepseek-ai/*` 声明成 `peerDependencies`。
> DSH 的解析层（`dsh-app-boot` 的 `routeLinked`）对「linked 插件」的规则是——目标包必须在安装目录的
> 解析表里，**并且某个祖先目录的 `package.json` 把该包列进了 `peerDependencies`**，然后才把请求路由到
> 安装目录那一份。所以删掉本地 `node_modules` 后插件照样能起来（踩过的坑，别再改成 `dependencies`）。

## 样式变量

`lib/client.js` 里的 CSS 只用 `--dsw-*` 设计变量。改样式后可以这样核对每个变量在发行包里确实有定义
（避免写出跟随主题时不生效的死变量）：

```powershell
# 列出插件用到的变量，逐个在 asar 解出来的 CSS/JS 里查一下名字是否出现过
Select-String -Path lib\client.js -Pattern '--dsw-[a-z0-9-]+' -AllMatches |
  ForEach-Object { $_.Matches.Value } | Sort-Object -Unique
```

## 这些脚本不覆盖什么

- 浏览器里的真实渲染（页面长什么样、卡片有没有画错）——只能靠真机看；
- `/api` 端点在真实连接层的鉴权（脚本直接调 handler，跳过了 `admit()`）；
- 真机上模型实际收到的请求体（要抓 provider 请求或读会话日志）；
- textarea 里的**真实光标位置**：渲染探针没有 DOM，点字段徽章只覆盖「插到最后一条规则 / 没规则时新建一条」这条兜底路径。

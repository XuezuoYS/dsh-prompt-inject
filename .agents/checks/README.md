# .agents/checks 怎么跑

这些脚本只用来验收插件，不属于交付物。分两类。

批量跑（不用一个个敲命令）：

```powershell
npm test        # 第一类：纯 node，任何机器上 clone 下来就能跑
npm run test:host   # 第二类：要官方包，没搭好环境会直接告诉你怎么搭（退出码 2）
npm run test:all    # 两类一起
```

## 一、直接 `node` 就能跑（不 import 官方包）

| 脚本 | 检查什么 |
| --- | --- |
| `client-shape.mjs` | 客户端半的 `__ModuleLoader__` 注册形状、`settings.section` 注册项、`inject` 声明、**订阅的「目录失效」事件与 host 表逐字一致**（另加 `connection/reset`） |
| `verify-template-fields.mjs` | **模板字段纯逻辑**：字段表、`{{字段}}` 替换规则（认不出/取不到值/名字不合规则一律原样保留）、agent 取值与组装期合并 |
| `verify-card-render.mjs` | 规则卡片的实际渲染：结论胶囊（全部 / 已应用 N 个模型 / 无应用 / 失效）、不再有标题与模型键、右侧四个图标动作、点胶囊与点删除分别调到哪个回调、Toast 的「撤销」动作、分组与 system 顺序、替换/插进标签、模板字段徽章与点击插入、拼错字段的轻提示 |
| `verify-panel-toggle.mjs` | **控制器级**折叠回归：用真实 `Controller` 走「点标题 → 发布快照 → 重渲染」，验证有/无规则两种默认、来回点严格交替、各注入点互不影响、提交的 payload 只含已知键 |
| `verify-model-route.mjs` | **模型路由回归**：官方的模型选择投影（pending → lastUsed）压过「最近一次已提交请求」，切换模型后 A 的专属规则不会跟进到 B；投影缺失时的回退链；system 中间锚点与 persona 头/尾改写都按同一条判据走 |
| `read-session.mjs` | 真机探针：把会话日志（多帧 zstd）解成「路由 / 注入 / 用户消息」时间线，核对这轮算的哪个模型、实际注入了什么 |

```powershell
npm test
# 等价于逐个跑：
node .agents/checks/client-shape.mjs
node .agents/checks/verify-template-fields.mjs
node .agents/checks/verify-card-render.mjs
node .agents/checks/verify-panel-toggle.mjs
node .agents/checks/verify-model-route.mjs
```

`read-session.mjs` 是查真机用的探针（不 import 任何包）：把会话日志 `.jsonl.zstd` 解成时间线，
一眼看到每轮 `CTX`（已提交的路由）/ `SEL`（用户点下拉）/ `HDR` 与每条注入消息：

```powershell
# 会话目录名由工作目录转义而来（`D:\proj\dsh-x` → `--D-proj-dsh-x--`），先列一下再挑
Get-ChildItem "$env:USERPROFILE\.dsh\sessions" | Select-Object -ExpandProperty Name
node .agents/checks/read-session.mjs "$env:USERPROFILE\.dsh\sessions\<转义后的工作目录>\session-xxxx\session.v4.jsonl.zstd" 摘要
```

> 日志是**多帧拼接**的 zstd（每次 append 一帧），Node 的 `zstdDecompressSync` 只解第一帧，
> 所以要按魔数 `28 B5 2F FD` 逐帧解——这个脚本里就是这个做法。

## 二、需要官方包（`@deepseek-ai/*`）

`verify-logic.mjs`（要 `dsh-llm` 系）、`verify-config-store.mjs`、`verify-host-wiring.mjs`、
`verify-inject-flow.mjs`、`verify-inject-persistence.mjs`、`verify-derived-cache.mjs`、
`verify-assemble-render.mjs`、`verify-catalog-refresh.mjs`、`verify-catalog-events.mjs`
都要 import 官方包（`@deepseek-ai/cordis`、`dsh-session`、`dsh-llm`、`dsh-atomic-write`、
`dsh-home-paths`、`dsh-system-prompt`、`dsh-api-remotes` 等）。

- `verify-assemble-render.mjs`：**真官方 SystemPrompt + 真 `renderPrompt`** 的集成回归——模板字段落位、
  没配改写的官方段仍由官方插值、没有 agent 时不炸、全不配时逐字不变。
- `verify-inject-persistence.mjs`、`verify-inject-flow.mjs`、`verify-derived-cache.mjs` 跑的是**真 SessionStore**（不是替身）。
  前者断言注入**永久保留**、一轮轮累积（第 N 轮就是 N 条）、顺序是「PREFIX → 该轮原文 → SUFFIX」、
  工具循环不重复注入、历史里不再有空占位。

**模型目录实时刷新**那两件：

- `verify-catalog-refresh.mjs`（**客户端半**）：用假宿主 + 真 `Controller` 走一遍——推送来了就重拉 `/catalog`、
  连推三条只合并成一次、**只换目录**（规则 / revision /「保存中…」都不动）、拉失败留旧目录、
  老 host 回 404 也不炸；第二段用**真 cordis** 验「`remote` 服务晚挂上也能补上订阅」。
- `verify-catalog-events.mjs`（**host 半**）：先核官方白名单 `API_REMOTE_FORWARDED_EVENTS`
  （名字不在里面 = 永远收不到推送），再用**真 cordis**（官方服务用替身）把四条事件各推一次，
  断言目录缓存当场失效、并且插件停用后监听器与端点一起消失。

DSH 发行包把官方包放在 `app.asar` 里，磁盘上没有，所以要临时抽一份出来。**跑完都删掉**，仓库里不留（`node_modules/` 已在 `.gitignore`）。

**要达到的形状**（本机实测可用：287 个包 / 约 2900 文件 / 52 MB）：

```
<临时目录>\                      <- 平铺解包：一个包一个子目录，名字不带 @deepseek-ai/ 前缀
  cordis\  dsh-llm\  dsh-session\  ...
  node_modules\@deepseek-ai\    <- 一层 junction，逐个指回上面那些平铺目录
仓库根\node_modules\@deepseek-ai  <- junction 指到那一层（不是整棵 node_modules）
```

```powershell
# 发行包位置：Windows 桌面版默认在这。自定义安装目录 / 别的系统就改这一个变量
$asar = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app.asar"
$flat = "$env:TEMP\dsh-pi\ok"
$umb  = "$flat\node_modules\@deepseek-ai"

# 1) 抽包。现成读取器：`.agents/archive/asar2.cjs`，用法 `list` / `read` / `extract`。
#    innerPath 给到 `dsh/node_modules/@deepseek-ai`：它会剥掉这段前缀，于是每个包正好平铺成
#    $flat\<包名>（不带作用域目录）——这是下面套 junction 的前提。
node .agents/archive/asar2.cjs extract $asar "dsh/node_modules/@deepseek-ai" $flat

# 1b)（可选）连 `dsh` 主包一起解出来，查 host 源码 / CSS 变量时用得上
node .agents/archive/asar2.cjs extract $asar "dsh" "$flat\dsh"

# 2) 套一层 @deepseek-ai 目录 —— 官方包互引（如 cordis 引 @deepseek-ai/cosmokit）
#    要求包目录真的位于某个 node_modules/@deepseek-ai/ 下面
New-Item -ItemType Directory -Path $umb -Force | Out-Null
Get-ChildItem $flat -Directory -Exclude node_modules | ForEach-Object {
  New-Item -ItemType Junction -Path (Join-Path $umb $_.Name) -Target $_.FullName | Out-Null
}

# 3) 仓库根指到这一层
New-Item -ItemType Directory -Path .\node_modules -Force | Out-Null
New-Item -ItemType Junction -Path .\node_modules\@deepseek-ai -Target $umb | Out-Null

npm run test:host

# 4) 清理：先删链接本身，再删空目录。
#    别对 .\node_modules 用 -Recurse —— 会顺着 junction 把解出来的那棵一起删掉
(Get-Item .\node_modules\@deepseek-ai).Delete()
Remove-Item .\node_modules
Remove-Item $flat -Recurse -Force
```

> 没搭这层环境时 `npm run test:host` 不会假装通过：它先探一次 `@deepseek-ai/cordis` 能不能解析，
> 探不到就打印上面这段搭法并**退出码 2**（和断言失败的 1 区分开）。
>
> **安装包的坑**：这份发行包的 asar 数据区起点是 `16 + pickledSize - 8`，不是官方 reader 的
> `16 + pickledSize`；用后者会把每个文件的开头吃掉 8 字节。现成可用的读取器在
> `.agents/archive/asar2.cjs`（`.agents/archive/2026-10-11-asar-reader.js` 是早期版本，
> 而且直接 `node` 跑它会失败：仓库根 `package.json` 是 `"type": "module"`，`.js` 会被当 ESM）。
>
> 插件自己在运行时**不需要**这份 `node_modules`：它把 `@deepseek-ai/*` 声明成 `peerDependencies`。
> DSH 的解析层（`dsh-app-boot` 的 `routeLinked`）对「linked 插件」的规则是——目标包必须在安装目录的
> 解析表里，**并且某个祖先目录的 `package.json` 把该包列进了 `peerDependencies`**，然后才把请求路由到
> 安装目录那一份。所以删掉本地 `node_modules` 后插件照样能起来（踩过的坑，别再改成 `dependencies`）。

## 手工探针（不断言，只打印）

- `verify-timeline.mjs`（要官方包）：多轮复刻时间线，打印每轮模型实际看到的消息，肉眼核对注入落位。
- `read-session.mjs`（不要官方包）：解真机的会话日志，命令在第一段。

这两个不会以非零码失败，所以没放进 `npm test` / `npm run test:host` 的跑批。

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

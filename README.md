# @xuezuoys/dsh-prompt-inject

[![Release](https://github.com/XuezuoYS/dsh-prompt-inject/actions/workflows/publish.yml/badge.svg)](https://github.com/XuezuoYS/dsh-prompt-inject/actions/workflows/publish.yml)
<a href="https://awesome-dsh-plugin.com/p/XuezuoYS/dsh-prompt-inject/"><img alt="Awesome DSH Plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>

适用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（以下简称 DSH 或 dsh）的提示词注入插件，此插件提供图形界面下分组、分模型的 System 和上下文提示词接入，分组设计可有效快捷地同时将多个不同效果的提示词组合分配给不同的模型。

- npm 包：[`@xuezuoys/dsh-prompt-inject`](https://www.npmjs.com/package/@xuezuoys/dsh-prompt-inject)
- 源码仓库：[XuezuoYS/dsh-prompt-inject](https://github.com/XuezuoYS/dsh-prompt-inject)
- 许可证：[MIT](LICENSE)

## 目录

- [简介](#简介)
- [功能特性](#功能特性)
- [兼容性](#兼容性)
- [安装](#安装)
- [使用](#使用)
- [注入位置](#注入位置)
- [用户前置词与后置词的保留行为](#用户前置词与后置词的保留行为)
- [模板字段](#模板字段)
- [模型作用域](#模型作用域)
- [配置文件](#配置文件)
- [已知限制](#已知限制)
- [开发](#开发)
- [许可](#许可)

## 简介

插件把提示词配置拆分为两层：

- **组**：配置单元，包含名称、启用开关、模型作用域，以及 8 个固定位置各一段文本。
- **位置**（代码与文档中也称「注入点」）：提示词实际落地的位置，包括用户输入前后的两条独立消息，以及 System 提示词中的六个段位。

同一位置可以由多个组共同提供文本：按组在页面中的顺序，将满足条件的组文本以空行连接后注入。因此提示词可以拆分为若干可复用、可独立启停的片段。组的模型作用域决定该组只对哪些 `<provider>/<model>` 组合生效。

配置保存在本机的 DSH home 目录；插件仅在安装它的 profile 中运行。

## 功能特性

- **分组配置**：最多 50 个组，可分别启停、重命名、排序，并限定作用模型；同一位置按组顺序拼合。
- **八个注入位置**：覆盖用户输入前后与 System 提示词的六个段位，支持「替换官方段落」与「新增段落」两种语义。
- **模板字段**：文本中可使用 `{{model}}`、`{{provider}}`、`{{cwd}}`，在组装或注入时按本次请求的真实值渲染。
- **自动保存**：文字编辑在停止输入 20 秒或失焦后提交；开关、排序、增删组、作用域勾选立即提交，无需保存按钮。
- **模型目录实时更新**：在 DSH 中增删改模型或密钥后，设置页无需重启或刷新即可获取新目录。
- **并发保护**：写入使用 revision 乐观锁与跨进程文件锁，冲突时载入最新值而不覆盖。
- **本地存储**：权限 0600 的 JSON 文件，采用原子替换写入；损坏文件被归档保留，不会被静默清空。

## 兼容性

| 项目 | 说明 |
| --- | --- |
| DSH 版本 | `engines.dsh` 为 `>=0.2.1-rc.2 <0.3.0`，目标为 dsh 最新 rc 版本 |
| DSH 官方包 | 以 `peerDependencies` 声明，由宿主提供，不随本包安装 |
| Node.js | 无额外要求，运行时由 DSH 提供 |
| 界面 | DSH Web 前端（桌面版内嵌同一前端） |

DSH 在安装与启动两个阶段校验插件声明的版本要求：

- **安装阶段**：不满足 `engines.dsh` 的版本会被拒绝安装。确需在范围外的 DSH 上使用时，可按 DSH 文档为该精确版本添加豁免。
- **启动阶段**：已安装但不满足要求的组合包会被跳过，原因记录在启动诊断的 `skippedBundles` 中，其他组合包继续启动。
- DSH 仍处于 developer preview 阶段，破坏性变更较为常见。升级 DSH 后若插件不再出现，应首先核对本包的 `engines.dsh` 范围。

## 安装

安装有两种方式：图形界面的「插件」页与 `dsh plugin` 命令。两种方式都会把包安装到目标 profile，并把组合包加入该 profile 的 `dsh.profile.bundles`；新安装的组合包默认启用。

### 图形界面

在 DSH 界面侧栏进入「插件」页，通过「添加插件」输入包名 `@xuezuoys/dsh-prompt-inject` 并按页面提示完成安装。已安装的组合包可在该页启用、停用或卸载，卸载需要二次确认。

### 命令行

```sh
dsh plugin --profile web add @xuezuoys/dsh-prompt-inject
```

- `--profile` 指定目标 profile。通过 `dsh web` 启动的 Web UI 使用 `web`；首次对该 profile 执行插件命令时，DSH 会按内置模板初始化它。
- 桌面版的 profile（`desktop`）由桌面应用持有，推荐在桌面版界面的插件页中管理。
- 命令最终由 profile 目录中的 pnpm 执行安装，并在安装成功后同步组合包选择；`github:所有者/仓库` 等写法遵循 pnpm 的规范。

从 Git 安装：

```sh
# 跟踪默认分支的最新提交
dsh plugin --profile web add github:XuezuoYS/dsh-prompt-inject

# 固定到具体提交，避免后续推送改变实际运行的代码
dsh plugin --profile web add github:XuezuoYS/dsh-prompt-inject#<commit>
```

本包为纯 JavaScript、无构建步骤，`package.json` 未声明 `prepare`、`install` 等生命周期脚本，因此从 Git 安装时无需额外授予构建脚本权限。

安装完成后是否立即生效取决于 profile 的 HMR 设置：启用了 HMR 时，宿主会重新组合配置并立即生效；未启用时需要重启宿主。插件页会报告本次操作是已应用（`applied`）还是需要重启（`restart-required`）；使用命令行安装后若宿主正在运行且未启用 HMR，重启一次宿主即可。

### 验证与卸载

对于由 CLI 管理的 profile，可以在不启动宿主的情况下检查组合结果：

```sh
dsh --profile web --dump-config
```

输出以 `# == <来源>` 注释分段，标明每段配置来自哪个组合包或 patch 文件。安装成功后，输出中应出现 `# == @xuezuoys/dsh-prompt-inject`，其后是插件插入的 host 条目。

卸载：

```sh
dsh plugin --profile web remove @xuezuoys/dsh-prompt-inject
```

也可以在插件页的「已安装插件」中卸载。卸载会移除 profile 中的依赖与组合包选择，本插件贡献的配置层随之不再应用；配置文件 `rules.json` 不会被删除，重新安装后原有配置继续可用。

## 使用

安装并生效后，设置导航中新增一项「dsh-prompt-inject」。有组时，页面由置顶的顶栏、组卡片列表和底部的「＋ 新增组」按钮组成；没有任何组时显示居中的空状态。

### 首次使用

1. 打开 设置 → dsh-prompt-inject。
2. 点击「＋ 新建组」创建第一个组。
3. 展开需要写入的位置，输入文本，并确认该位置的开关已打开。
4. 停止输入 20 秒或移开输入焦点；顶栏显示「已保存」后，新配置作用于后续请求。

### 页面结构

- **顶栏**：滚动时保持置顶。左侧为「模板字段」下拉与「全部折叠 / 全部展开」按钮（有组时才显示按钮），右侧为保存状态；有组时顶栏内另显示一行说明：组顺序即同一位置的拼合顺序，关闭或留空的组与位置会被跳过。
- **组卡片**：一列纵向排列，从上到下即组的顺序与拼合顺序。
- **空状态**：零组时居中显示「还没有注入规则」与「＋ 新建组」，此时不显示底部的「＋ 新增组」；创建第一组后恢复常规列表。
- **折叠**：点击卡片最左侧的箭头可折叠单个组；顶栏按钮可一次折叠或展开全部组。折叠状态仅保存在页面中，不写入配置。

### 组卡片

组卡片头部包含折叠箭头、启用开关、组名输入框、模型作用域按钮、「已停用」标签、顺序徽章以及上移、下移和删除操作。

| 元素 | 行为 |
| --- | --- |
| 折叠箭头 | 折叠或展开该组；折叠后仅保留头部一行，头部操作仍可用 |
| 启用开关 | 关闭后整组不参与注入，位置与文本保留，卡片显示「已停用」 |
| 组名 | 单行输入，保存时校验，最多 60 字；编辑过程中允许为空，保存时若仍为空则恢复为该组最近一次保存成功的名称 |
| 模型作用域 | 显示 `全部`、`已应用 N 个模型` 或 `无应用`；存在失效模型键时另显示 `已失效 N`；点击打开多选面板 |
| 顺序徽章与上移 / 下移 | 徽章显示「第 N 组」；上移、下移按钮用于调整顺序，位于首尾时对应按钮禁用 |
| 删除 | 弹出确认对话框（取消 / 删除）；允许删除全部组，删除后回到空状态 |

新建组的默认状态为：启用、作用于全部模型、8 个位置全部关闭；名称为「组 N」，N 取当前组数加一，若与现有组名重复则顺延到下一个可用编号。

### 位置行

每个组固定包含 8 个位置，顺序固定为：用户前置词、用户后置词、system 头部、工具说明之前、工具说明之后、结构化输出之前、system 尾部、system 最末尾。

- 位置关闭时折叠为一行，显示开关、位置名、该位置的说明或官方段位说明，以及「已关闭」；system 位置另显示「替换」或「插进」标签。
- 位置开启后显示多行输入框；文本为空表示该位置不注入。
- 用户前置词与用户后置词展开时会显示保留提醒，详见[用户前置词与后置词的保留行为](#用户前置词与后置词的保留行为)。

### 保存机制

| 操作 | 保存时机 |
| --- | --- |
| 修改位置文本或组名 | 停止输入 20 秒后，或输入框失焦时 |
| 启用开关、上移 / 下移、新增 / 删除组、作用域勾选 | 立即提交，不进入等待状态 |

- 页面不存在显式的保存按钮。
- 执行离散操作时，若存在尚未提交的文本编辑，会一并提交。
- 同一时刻只执行一个保存请求；请求进行期间产生的新编辑会在该请求成功后补发一次，避免并发请求使用同一 revision 而互相冲突。
- 保存前会处理空组名：恢复为该组最近一次保存成功的名称后再提交。
- 页面卸载或插件停用时，尚未提交的编辑会尝试立即提交。
- 顶栏保存状态：编辑后为「等待编辑结束后保存」，提交期间为「保存中…」，结束后为「已保存」或「保存失败」；首次加载与加载失败分别显示「正在读取配置…」与「读取失败：…」。
- revision 不一致时，服务端返回 409，页面载入服务端最新值并提示，不会覆盖其他窗口的修改；校验失败时逐条显示问题，页面内容不会丢失；其他写入失败显示「保存失败」及原因。

## 注入位置

| 位置 | 配置键 | 注入方式 | 落点 |
| --- | --- | --- | --- |
| 用户前置词 | `user.prefix` | 插入独立 user 消息，每轮一次 | 当前用户输入之前 |
| 用户后置词 | `user.suffix` | 插入独立 user 消息，每轮一次 | 当前用户输入之后 |
| system 头部 | `system.personaHead` | 替换官方段落 | `deployment:persona-prefix`（order 0） |
| 工具说明之前 | `system.beforeTools` | 新增段落 | order 950 |
| 工具说明之后 | `system.afterTools` | 新增段落 | order 3050 |
| 结构化输出之前 | `system.middle` | 新增段落 | order 9800 |
| system 尾部 | `system.personaTail` | 替换官方段落 | `deployment:persona-suffix`（order 10200） |
| system 最末尾 | `system.last` | 新增段落 | order 10300 |

表中 system 位置的先后顺序即其在 System 提示词中的顺序；设置页内也按此顺序排列。

### 两种语义

- **替换**（用于 system 头部、system 尾部）：官方 `deployment:persona-prefix` 与 `deployment:persona-suffix` 两个段落本就存在，插件在 System 组装阶段改写其文本。某一侧拼合结果为空时，保持官方默认内容；不会产生重复段落，也不会删除官方段落。官方 persona 尾自 0.2.1 起默认为空串，因此 system 尾部的「替换」通常等价于新增，但语义仍为替换。
- **新增**（界面标签「插进」，用于工具说明之前、工具说明之后、结构化输出之前、system 最末尾）：官方没有对应段落，插件按指定 order 注册新段落。拼合结果为空时该段落会被官方渲染丢弃，等同于不存在，不会覆盖任何官方内容。

### 拼合规则

对任一位置，按以下步骤计算本次注入的文本：

1. 按页面顺序遍历全部组；
2. 保留同时满足四个条件的组：组已启用、组作用域匹配本次请求的模型、该位置已启用、该位置文本非空；
3. 将保留的文本按顺序以空行（`\n\n`）连接。

没有任何组满足条件时，该位置不注入。用户前置词、用户后置词与六个 system 位置使用同一规则。模型无法确定时（例如生成会话标题、压缩摘要这类没有 agent 的内部调用），只有作用域为「全部」的组会命中。

细节与官方段位参照表见 [docs/injectPoint.md](docs/injectPoint.md)。

## 用户前置词与后置词的保留行为

用户前置词与后置词以独立消息注入，会改变并长期保留会话历史，是插件唯一具有此类副作用的行为。

- **注入形式**：在当前用户消息之前或之后插入一条独立的 user 消息，用户原文本身不被修改。
- **永久保留**：注入后不再处理——不压缩、不删除、不还原，随会话历史逐轮累积。
- **每轮一次**：每轮用户输入只注入一次；工具调用循环中的后续请求不会重复注入，本轮已注入的内容继续保留。
- **已知代价**：上一轮的后置词会位于上一轮用户原文与下一轮输入之间，模型可能把它当成用户补充的指示。因此这两个位置只应写入与轮次无关、不会产生歧义的内容，例如统一的输出要求；不应写入时间、轮次或指代性内容。
- **聊天记录**：用户实际发送的消息保持原样，聊天记录仍以原文为准。
- **provider 侧**：连续的 user 消息在 DeepSeek adapter 中合并为一条 `{前置词}原文{后置词}`；不执行合并的 adapter（如 pi-ai）会收到三条消息。
- **替代方案**：若某段文本只应作用于 System、不应进入用户历史，应改用 system 位置。

## 模板字段

位置文本中可以使用模板字段，在组装或注入时替换为本次请求的实际值。

| 字段 | 替换为 |
| --- | --- |
| `{{model}}` | 本次请求使用的模型 id，例如 `deepseek-flash` |
| `{{provider}}` | 该模型所属 provider 的 id，例如 `deepseek-account` |
| `{{cwd}}` | 当前会话工作目录的绝对路径 |

`model` 与 `provider` 是 DSH 官方注册的提示词变量（官方 persona 头即使用 `{{model}}`）；`cwd` 自 0.2.1 起不再由官方注册，由插件从会话头读取。字段表是静态白名单，不反射官方或其他插件的变量注册表；渲染时按白名单从本次组装变量或 agent 上取值。

### 插入方式

点击顶栏左侧的「模板字段」下拉并选择字段，即可将 `{{字段}}` 插入目标位置。菜单在打开与选择期间不会夺取输入框焦点，插入位置为光标处。未处于编辑状态时，按以下顺序确定目标：

1. 焦点位于某个位置输入框——插入到光标处；
2. 最近编辑过的位置（组与位置仍然存在，且位置仍处于启用状态）——插入到该位置记录的光标处；
3. 第一个存在「已启用且文本非空」位置的组——取其中最后一个这样的位置，追加到文本末尾；
4. 第一个组的「用户前置词」——自动启用该位置并追加；
5. 不存在任何组——先创建「组 1」，启用其「用户前置词」并写入字段。

### 渲染时机

- 用户前置词、用户后置词：在注入时渲染为成品并写入历史；此后字段值变化不会影响已注入的文本。
- 六个 system 位置：在组装 System 提示词时，先按组顺序拼合，再渲染；渲染后的段落标记为不再插值（`interpolate: false`），官方插值器不会再次处理其中的花括号。

### 容错规则

名称不在字段表中、名称不符合规则（须匹配 `^[a-z][a-z0-9_]*$`）或本次取不到值的字段，均原样保留为 `{{名字}}`，不报错、不阻断请求。需要输出字面量 `{{model}}` 时，可写成 `{{ model }}` 或改变大小写，这些形式不会被识别为字段。

设置页会对字段表中不存在的小写名称在输入框下方给出提示，但不阻止保存。

## 模型作用域

- 作用域设置在组上，作用于该组的全部 8 个位置。
- 模型键格式为 `<provider>/<model>`，例如 `deepseek-account/deepseek-flash`。
- 作用域面板列出「全部模型」选项与当前目录中的模型，按 provider 分组并支持搜索；某个 provider 的目录拉取失败时，面板顶部会给出说明，已勾选但目录中找不到的模型会显示为「已失效」。
- 选择「全部模型」表示匹配所有模型，包括之后新增的模型，且不会清空其他勾选；取消该选项后，之前勾选的模型继续生效。
- 既未选择「全部模型」也未勾选任何模型时，该组当前不生效，作用域按钮显示「无应用」。
- 已保存但当前目录中不存在的模型键显示为「已失效」并保持勾选；在用户取消勾选前，这些键按不匹配处理。若组的作用域仅依赖这些键，则整组不注入。
- 设置页不显示「当前模型」。多会话并行时该值可能指向其他会话或滞后于切换，用它做提示会产生误导；组是否命中应以作用域按钮的结论与面板内容为准。

### 目录刷新

在 DSH 中增删改模型、修改密钥后，设置页无需重启或刷新即可获得新目录：

- host 侧监听 `llm/adapters-updated`、`settings/document-updated`、`credentials/record-updated`、`credentials/reference-updated` 四类事件，收到后丢弃目录缓存（30 秒 TTL 仅作最后保障）。
- 客户端收到同一批推送后，合并 150 毫秒再重新请求 `/catalog`，并在连接重置（`connection/reset`）后补拉一次。
- 该刷新只更新模型目录，不重读组配置，因此不会覆盖正在编辑但尚未保存的内容。
- 目录的实时更新仅覆盖 DSH 自身推送的变化。直接修改 DSH 配置文件或远端 provider 自行上下架模型不会触发推送，此时等待最多 30 秒让宿主目录缓存过期，再刷新页面即可获取新目录。

### 路由判据

判断「本次请求使用哪个模型」只有一个判据（`lib/modelRoute.js`），用户前置词、用户后置词与 system 位置共用：

1. 官方模型选择投影（`sessionProjections` 的 `modelSelection` 单元，`pending` 优先于 `lastUsed`）；
2. 无法取得投影时，使用会话最近一次已提交请求的路由；
3. 再退到 agent 建立时的 `provider` 与 `model` 选项。

System 头部与尾部的改写另有一层更精确的来源：组装结果 `variables` 中的 `provider` 与 `model` 由官方在本次组装中确定，存在时优先使用。

作用域与拼合的细节见 [docs/injectScopeAndSetting.md](docs/injectScopeAndSetting.md)。

## 配置文件

配置文件路径：`~/.dsh/dsh-prompt-inject/rules.json`。Windows 上通常为 `%USERPROFILE%\.dsh\dsh-prompt-inject\rules.json`；`.dsh` 的实际位置由 DSH 宿主决定。

该文件位于 DSH home 下，不按 profile 区分；同一 DSH home 下安装本插件的多个 profile 共用同一份配置。

### 写入行为

- 配置由 host 侧负责写入；写入前创建目录（权限 0700），文件权限为 0600。
- 使用原子替换写入，不会留下写到一半的文件。
- 使用同目录文件锁在多进程间排队，多个窗口同时保存不会互相覆盖。
- `revision` 每次成功写入加一。提交时必须携带读取时的 revision；不一致时返回 409，客户端载入服务端最新值，避免旧内容覆盖新内容。
- 文件无法解析或结构版本不受支持时，会被重命名为 `rules.json.<时间戳>.bad` 以保留现场，插件随后以空配置继续运行，不会静默清空已有内容。

### 结构与示例

组数组的顺序即页面顺序与拼合顺序：

```json
{
  "version": 2,
  "revision": 12,
  "groups": [
    {
      "id": "g1",
      "name": "全局要求",
      "enabled": true,
      "models": { "all": true, "list": [] },
      "positions": {
        "user.prefix": { "enabled": true, "text": "总是用中文回答" },
        "user.suffix": { "enabled": false, "text": "" },
        "system.personaHead": { "enabled": false, "text": "" },
        "system.beforeTools": { "enabled": false, "text": "" },
        "system.afterTools": { "enabled": false, "text": "" },
        "system.middle": { "enabled": false, "text": "" },
        "system.personaTail": { "enabled": false, "text": "" },
        "system.last": { "enabled": false, "text": "" }
      }
    },
    {
      "id": "g2",
      "name": "flash 专用",
      "enabled": true,
      "models": { "all": false, "list": ["deepseek-account/deepseek-flash"] },
      "positions": {
        "user.prefix": { "enabled": false, "text": "" },
        "user.suffix": { "enabled": false, "text": "" },
        "system.personaHead": { "enabled": false, "text": "" },
        "system.beforeTools": { "enabled": false, "text": "" },
        "system.afterTools": { "enabled": false, "text": "" },
        "system.middle": { "enabled": false, "text": "" },
        "system.personaTail": { "enabled": false, "text": "" },
        "system.last": { "enabled": true, "text": "回答完用一句话总结。" }
      }
    }
  ]
}
```

### 字段说明

| 字段 | 说明 |
| --- | --- |
| `version` | 结构版本；`1` 为旧结构（读取时迁移），`2` 为当前结构，其余值按损坏文件处理 |
| `revision` | 写入计数，用于并发控制 |
| `groups` | 组数组，允许为空，最多 50 组 |

组对象：

| 字段 | 说明 |
| --- | --- |
| `id` | 组标识，最多 128 字，同一份配置内不可重复 |
| `name` | 组名，最多 60 字；不要求唯一 |
| `enabled` | 组启用开关 |
| `models.all` | 是否匹配全部模型，包括之后新增的模型 |
| `models.list` | 勾选的模型键，最多 500 个，写入时自动去重；`all` 为 `true` 时仍保留，取消「全部」后继续生效 |
| `positions` | 8 个位置块，键为注入位置键 |

位置块为 `{ "enabled": boolean, "text": string }`：默认 `{ "enabled": false, "text": "" }`；位置启用但文本为空等同于未配置；单个位置的文本最多 100000 字；缺少的位置键在读取时按默认值补全。

其他约定：

- `groups` 为空数组合法，表示不注入任何内容。
- `models.all` 为 `false` 且 `models.list` 为空时，该组对任何模型都不生效。
- 组名输入过程中允许为空；设置页保存时会恢复为该组最近一次保存成功的名称。
- 超过数量或长度上限时保存失败，服务端逐条返回问题，已有配置不受影响。

### 从 v1 迁移

首次读取 `version: 1` 的旧文件时：

1. 复制一份 `rules.json.v1.bak`，原文件保持不变；
2. 在内存中迁移为一个默认组：`id` 为 `default`，名称为「默认组」，启用，作用于全部模型；
3. 每个位置，旧规则的文本按顺序以空行合并（停用规则的文本同样并入）；位置开关取决于该位置是否存在启用的旧规则；
4. 旧规则各自的模型勾选不保留，统一为全部模型。

迁移结果在内存中即为 v2 结构，下一次保存时才写入文件。

旧版客户端提交 `{ revision, slots }` 时，服务端返回 422 并提示刷新页面；新客户端提交 `{ revision, groups }`。请求中出现的未知位置键会被丢弃并记录在响应的 `dropped` 字段中，不会导致整次保存失败。

建议仅通过设置页修改该文件。手工编辑可能与未提交的编辑产生 revision 冲突，格式错误还会被当作损坏文件归档。

完整字段说明见 [docs/userData.md](docs/userData.md)，版本记录见 [docs/userDataUpdateLog.md](docs/userDataUpdateLog.md)。

## 已知限制

- 用户前置词与后置词永久保留在会话历史中，无法由插件清除，详见[用户前置词与后置词的保留行为](#用户前置词与后置词的保留行为)。
- 设置页不显示当前模型，也不提供某个位置最终拼合结果的预览。
- 组排序仅支持上移与下移，不支持拖拽；8 个位置的顺序固定，不可调整。
- 不支持复制整个组，相同配置需要手动重建。
- 模型目录的实时更新仅覆盖 DSH 自身推送的变化，见[目录刷新](#目录刷新)。
- 配置存在数量与长度上限，超限时保存失败，见[配置文件](#配置文件)。
- 设置页界面文案目前仅提供中文；插件列表中的标题与描述提供中英文（见 `locale/zh.json` 与 `locale/en.json`）；位置键名与模型键保持英文原样。
- 旧版本在会话历史中留下的空注入占位节点无法删除（DSH 的会话 surface 未提供删除节点的 API），新版本不再产生这类节点。
- `engines.dsh` 限定为 `>=0.2.1-rc.2 <0.3.0`；升级 DSH 大版本前应确认本包已支持该版本。

## 开发

本包是一个 npm 包，分为 host 与 client 两部分：host 为 cordis 插件，持有配置文件、注入逻辑与 HTTP 端点；client 为手写的浏览器包（不经过构建工具），由 `package.json` 的 `dsh.client` 声明。

### 代码结构

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | host 入口：装配配置存储、注入器、HTTP 端点与 System 段注册 |
| `lib/injectPoints.js` | 注入位置表（host 侧权威定义：键、顺序、order、官方段名与双语标签） |
| `lib/groupConfig.js` | 组结构与默认值、读取规整、v1 到 v2 的迁移 |
| `lib/configValidation.js` | 保存前的字段校验与上限检查 |
| `lib/groupResolver.js` | 按组顺序、作用域与位置状态拼合位置文本 |
| `lib/modelRoute.js` | 「本次请求使用哪个模型」的唯一判据 |
| `lib/templateFields.js` | 模板字段白名单、取值与渲染 |
| `lib/sessionInjector.js` | 用户前置词与后置词的注入（`agent/pre-step`） |
| `lib/systemSections.js` | system 中段的 section 注册（4 个）与 persona 头尾的改写（2 个） |
| `lib/settingsApi.js` | `/api/dsh-prompt-inject/*` 端点与模型目录缓存 |
| `lib/configStore.js` | `rules.json` 的读写、文件锁、revision 与损坏归档 |
| `lib/client.js` | 浏览器端：设置页、组编辑器与目录刷新 |
| `locale/zh.json`、`locale/en.json` | 插件列表中的本地化标题与描述 |
| `cordis.patch.yml` | bundle patch，插入 host 条目 |

### 关键约定

- 注入位置表有两份：`lib/injectPoints.js` 为权威来源；浏览器端不能 import，因此 `lib/client.js` 内联了一份相同的定义。修改时需同步两处；`tests/client-shape.mjs` 会校验键集合、键顺序与 `notice` 文案，标签等文案需人工核对。
- 插件 import 的 `@deepseek-ai/*` 包必须声明为 `peerDependencies`（`dsh.client.inject` 中引用的客户端模块不在此列）。若声明为普通依赖，插件会加载到第二份模块实例，导致 `instanceof` 判断与模块私有 WeakSet 失效。
- 浏览器端通过 `require('@deepseek-ai/dsh-client-ui-primitives')` 使用官方 UI 组件。自 0.2.1 起该包不再作为独立包落盘，而是 Web 前端模块表中的 baseline 模块，`require` 仍可解析，因此 `dsh.client.inject` 中不列出它，`peerDependencies` 中的声明仅用于标注版本。`dsh.client.external` 与 `immediately` 未使用。
- HTTP 端点注册在官方 `/api` 路由下，鉴权由官方连接层处理，插件不自行实现；仅支持 `GET`、`HEAD`、`POST` 三种方法。
- host 侧代码修改后需要重启宿主才能生效；仅修改浏览器端时刷新页面即可。
- 界面样式只使用 `--dsw-*` 设计变量，并在 `prefers-reduced-motion` 下关闭动效。

### 数据通道

host 侧通过 `ctx.connection.fetch.register` 在 `/api/dsh-prompt-inject` 下注册端点：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` / `HEAD` | `/api/dsh-prompt-inject/state` | 组配置、模板字段表、revision 与模型目录 |
| `GET` / `HEAD` | `/api/dsh-prompt-inject/catalog` | 仅模型目录；用于目录刷新，不重读组配置 |
| `POST` | `/api/dsh-prompt-inject/rules` | 覆盖写入组配置，请求体为 `{ revision, groups }` |

响应约定：写入成功返回 200 与最新的 `revision`、`groups`；revision 不一致返回 409 与服务端最新值；组校验失败返回 422 与逐条 `issues`，被忽略的未知位置键记录在 `dropped` 中。请求体无法解析或形状错误同样返回 422，但只带错误码。

### 校验脚本

| 命令 | 内容 |
| --- | --- |
| `npm test` | 第一组：纯 Node，不依赖官方包 |
| `npm run test:host` | 第二组：需要发行包 `app.asar` 中的官方包；环境未就绪时退出码为 2 并打印搭建方法 |
| `npm run test:all` | 两组依次运行；第二组环境缺失时整次以退出码 1 结束 |

测试分为两组的原因、各脚本的覆盖范围与官方包的临时解包方法见 [tests/README.md](tests/README.md)。

### 发布

发布只通过 `release` 分支触发：

1. 更新 `package.json` 的 `version`，并以 `v` 加该版本号创建 tag；
2. 将提交与 tag 推送到 `release` 分支；
3. GitHub Actions 运行 `.github/workflows/publish.yml`，根据最近的 tag 与推送前 `release` 的状态判断是否需要发布；需要时执行测试、`npm publish` 并创建 GitHub Release。

CI 只运行第一组测试（第二组依赖发行包中的官方包）。已存在的 npm 版本与 GitHub Release 会被跳过，因此流水线可以安全重跑。npm 认证使用 Trusted Publishing（OIDC），仓库不保存长期 token；首次发布需在本地创建包，并在 npm 上配置对应的 GitHub Actions 信任关系。完整流程见 [docs/release.md](docs/release.md)。

### 文档

| 文档 | 内容 |
| --- | --- |
| [docs/injectPoint.md](docs/injectPoint.md) | 注入位置、官方段位、两种语义的由来与约束 |
| [docs/injectFormat.md](docs/injectFormat.md) | 用户前置词与后置词的注入格式、模板字段与渲染时机 |
| [docs/injectScopeAndSetting.md](docs/injectScopeAndSetting.md) | 组与位置的层级、模型作用域、路由判据 |
| [docs/settingGUI.md](docs/settingGUI.md) | 设置界面、数据通道与目录刷新事件 |
| [docs/userData.md](docs/userData.md) | 数据结构、字段、拼合、上限、坏文件与迁移 |
| [docs/userDataUpdateLog.md](docs/userDataUpdateLog.md) | 数据模型版本记录与 v1 到 v2 的迁移 |
| [docs/release.md](docs/release.md) | 发布流程 |
| [tests/README.md](tests/README.md) | 验收脚本分组与环境搭建 |
| [AGENTS.md](AGENTS.md) | 开发与协作约定 |

问题与建议请提交至 [GitHub Issues](https://github.com/XuezuoYS/dsh-prompt-inject/issues)。

## 许可

本项目采用 [MIT 许可证](LICENSE)。

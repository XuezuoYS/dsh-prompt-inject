# 注入位置

相关：[injectFormat.md](injectFormat.md)（注入格式）、[injectScopeAndSetting.md](injectScopeAndSetting.md)（配置模型）、[settingGUI.md](settingGUI.md)（设置界面）。

## 注入点

每条注入点下的规则怎么配（多条规则、顺序、启用、作用域模型），见 [injectScopeAndSetting.md](injectScopeAndSetting.md)。

| 注入点 | 位置 | 官方锚点 | 实现 | 语义 |
| --- | --- | --- | --- | --- |
| `user.prefix` | 用户输入之前 | 无（DSH 没有这个概念，本插件加的） | `agent/pre-step` 插一条独立 user 消息 | 插入 |
| `user.suffix` | 用户输入之后 | 同上 | 同上 | 插入 |
| `system.personaHead` | system 头 | `deployment:persona-prefix`（order 0） | 全局 `system-prompt/assemble` 监听器改写这一段文本 | **替换**官方头 |
| `system.beforeTools` | 工具说明之前 | order 950 | 全局 `section()` + 函数式 `text` | 插入新段 |
| `system.afterTools` | 工具说明之后 | order 3050 | 同上 | 插入新段 |
| `system.middle` | 结构化输出之前 | order 9800 | 同上 | 插入新段 |
| `system.personaTail` | system 尾 | `deployment:persona-suffix`（order 10200） | 同头，改写这一段 | **替换**官方尾 |
| `system.last` | system 最末尾（persona 尾之后） | order 10300 | 全局 `section()` + 函数式 `text` | 插入新段 |

**上面这张表的顺序就是它们在 system 里出现的先后**（设置页也按这个顺序排，头与尾不挨着）。

两种语义分得很清楚：

- **替换**（头 / 尾）：官方 `deployment:persona-prefix` 段本来就是 deployment 的 persona 配置，插件不改注册、只在 `system-prompt/assemble` 里把已有那一段的文本换掉。没配就原样返回（官方默认）。
- **插入**（4 个中段）：官方没有对应段落，插件用全局 `systemPrompt.section({ name: 'prompt-inject:xxx', order })` 新加一段，落在指定段位。不配（解析出空串）时该段会被官方渲染丢掉，等于不存在。

所以「替换」不会让官方段消失、也不会多出重复段；「插入」不会覆盖任何官方段。

system 段位参照（挑 order 时看）：

| order | 段 |
| --- | --- |
| -1000 | `harness:identity` |
| **0** | `deployment:persona-prefix`（官方头） |
| 500 / 600 / 800 / 900 | plan / team / ptc / 文件引用 |
| 1000–3000 | 各工具说明 |
| 3100 / 5000 | MCP / 工具 SDK |
| 9000 / 9900 / 10000 / 10100 | 交付物 / 结构化输出 / 源码路径 / Web 端 |
| **10200** | `deployment:persona-suffix`（官方尾） |

## 用户前置词 / 后置词

- 一轮只注入一次：`agent/pre-step` 认领到 `source.kind === "user"` 的消息时，在它前后各插一条独立 user 消息；
  `source.kind` 用自己的名字（不能是 `user`，否则会被画成用户气泡）。
- **整轮保持**：工具循环的后续请求不新增注入，本轮那份继续留在历史里。
- **永久保留**：注入之后就再也不动它——不再用 `surfaceOp.replace` 把「前缀 + 原文 + 后缀」压回原文，也不会清除。
  注入消息就作为普通上下文块留在会话历史里，一轮轮累积。
- **代价**：上一轮的后置词会留在下一轮上下文里，夹在上一轮原文与下一轮输入之间，模型会当成「用户又补充了一句」。
  这是有意保留注入换来的，属正常现象，不是 bug。
- 触发规则：认领到用户消息 → 只注入，不做还原；没有用户消息（工具循环的续跑）→ 什么都不做。
- 用户那条消息本身**不改**（它是聊天记录的真源），前后缀必须是独立消息。
- 只剩一处扫尾：老版本留在历史里的空占位节点（`prompt-inject` 且内容为空）仍会被顺手清掉。

到 provider 那边，连续的 user 消息会被 DeepSeek adapter 合并成一条 `{前置词}原文{后置词}`；pi-ai 那类不合并，是三条。

## system 头与尾（替换官方段）

官方把 persona 头尾当**一个配置对**（同一行插件同时管两头）提供，但本插件的注入列表里它们是**两个并列注入点** `system.personaHead` 与 `system.personaTail`，各有自己的规则列表，不需要用户理解「二合一」这种说法：

- 落地：头有规则就改写 `deployment:persona-prefix` 的文本，尾有规则就改写 `deployment:persona-suffix` 的文本；没配的那一侧**不动**（保留官方默认）。0.2.1 起官方尾默认就是空串，所以「尾部」基本等于纯新增，但语义仍是替换。
- **不能**自己注册 `deployment:persona-prefix` / `-suffix`：桌面的 agent preset 已经挂了官方 persona 行，同一作用域重名注册会被**静默拒绝**（插件 fiber 进失败态，不抛错）——所以只能「替换已有段的文本」，不能「插入同名段」。
- 改写放在 `system-prompt/assemble` 里，按 `context.agent` 取该会话与模型的规则，改完立刻生效。

## 约束

- DSH 的 system 是 surface 第 0 节点的 `system/message`，不是请求字段；请求级 `system` 官方禁止（`request/header` 带 `header.system` 直接抛错）。
- `agent/pre-step` 每个 step 都触发（工具循环里也触发），必须自己判断是不是用户轮。
- 段文本里的 `{{字段}}` 由插件渲染（字段表与语义见 [injectFormat.md](injectFormat.md) 的「模板字段」），渲染完标 `interpolate: false`，官方插值器不会碰到我们注入的文本；**没配改写的那一侧官方段原样不动**，它自己的插值照旧归官方（0.2.1 官方只注册 `provider` / `model` 两个变量）。
- 消息落库只发生在本步第一次尝试，流失败重试不会重复注入。
- `order` 必须是有限数；段文本里写未注册的 `{{变量}}` 渲染时报错，要写字面 `{{` 用 `interpolate: false`。
- 同一作用域内重名段 / context / 变量会抛错；子作用域同名覆盖父作用域。
- 空段会被官方丢掉，各段用空行连接。
- 插件里的 `@deepseek-ai/*` 导入要声明成 `peerDependencies`；装成本地依赖会变成两份模块，`instanceof` 和模块私有 WeakSet 都会失效。

## 背景资料

架构背景、备选路线、实验记录、源码索引：[.agents/archive/2026-10-11-injectPoint-research.md](<../.agents/archive/2026-10-11-injectPoint-research.md>)

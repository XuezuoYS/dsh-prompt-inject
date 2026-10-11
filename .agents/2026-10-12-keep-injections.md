# 2026-10-12：改成「注入永久保留、不再自动清除」

## 用户的要求

原话意思：自动清除会严重干扰轨迹视图，现在不再要求删除操作，注入单纯作为插入的上下文块即可；
并在设置页加入"不会自动清除"的提示，同步改 `docs/` 下的说明。

用户还明确选了两件事：
1. **写死成永远保留**，不做成开关；
2. **完全不还原**（连后缀也不还原），设置页在后置词那一块提示"可能被当成用户补充"。

## 改了什么

### host：`lib/sessionInjector.js`

- `onPreStep` **不再调用** `restoreLeftovers`——每一轮只做注入，不产生任何 `surfaceOp.replace`。
- 新增 `removeEmptyInjectNodes`：每轮顺手清掉历史里**空的**注入占位节点
  （`kind === 'prompt-inject'` 且 `content` 为空）。这些是旧行为留下的空卡片，清掉不影响轨迹与模型上下文；
  非空的注入正文一律不动。
- `restoreLeftovers` / `planRestore` / `applyRestore` / `applyDrop` 保留但**不再被生产路径调用**：
  `planRestore` 是纯函数，`verify-logic.mjs` 的 46 条断言继续守着它。
  留着是为了将来若要把「自动清除」重新做成选项时不必从零写；函数注释里写清了这一点。

### client：`lib/client.js` + `lib/injectPoints.js`

- 注入点新增可选字段 `notice`（长文案、会换行的提示块），在**折叠小节展开后、规则列表上方**渲染。
  不塞进 `hint`：那行是 `white-space: nowrap` + 省略号，长文案会被切掉。
- `user.prefix` / `user.suffix` 各带一条 `notice`，host 与 client 两份内联表逐字一致。
- 用户分组的标题提示补了"注入后不会自动清除"。

### 验收脚本

- `verify-inject-flow.mjs`：第 2 轮的旧预期（"上一轮已还原"）改成新行为——注入各出现 2 次、无空占位。
- `verify-no-postfix-leak.mjs` → 改名 **`verify-inject-persistence.mjs`**，断言反过来：
  第 N 轮注入累积 N 条、每轮都是 `PREFIX → 该轮原文 → SUFFIX` 的相邻三元组、工具循环不重复注入、无空 user 消息。
- `client-shape.mjs`：新增「host 注入点表 ↔ client 内联表」对表——只对**键集合**与 **notice 文案**，
  外加"两个用户注入点必须带 notice"。label / hint 是 UI 短文案，两边本来就不同，不做约束。

### 文档

- `README.md`、`docs/injectPoint.md`：用户前后缀一节改成「永久保留 + 代价」。
- `docs/settingGUI.md`：补了 `notice` 这个 UI 元素的说明。
- `.agents/checks/README.md`、`README.md` 的开发段：脚本改名 + 说明 `verify-logic` 测的是不再被调用的纯判据。

## 行为与代价（写进文档的口径）

- 注入一次、当轮生效、之后**永久留在历史里**，一轮轮累积；
- 代价：上一轮的后置词会夹在「上一轮原文」和「下一轮输入」之间，模型可能当成「用户又补充了一句」。
  用户已知情并接受——这原本是第一轮报的那个 bug，现在是**有意保留**。

## 没做的事

- 没做开关（用户选择写死）。
- 没删 `restoreLeftovers` 一套代码（保留 + 注释说明，`verify-logic` 继续守着）。
- `docs/injectFormat.md` 里那张 `user1` / `user2` 的示意表在"永久保留"下略显过时，
  但那是**格式示意**不是行为承诺，docs-writer 判断不硬加，我同意——先留着。

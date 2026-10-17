# 2026-10-12：规则正文支持官方模板字段（`{{model}}` / `{{provider}}` / `{{cwd}}`）

## 用户的要求

规则正文里可以写官方的提示词变量，发送时置入官方对应的字段；system 与用户输入两类注入点都支持；
设置页要给出**可用的字段与注释**。

用户还拍了三件事：

1. 取不到值时 `{{model}}` **原样保留**（不换空串、也不整条跳过）；
2. 设置页**每个注入点展开后一行字段徽章 + 注释**，点徽章把 `{{model}}` **插到光标处**；
3. 拼错的字段**保存不拦**，只在规则卡片里给一条轻提示。

## 官方那边的事实（从发行包 `app.asar` 里读出来的）

- 段文本里的 `{{name}}` 由 `@deepseek-ai/dsh-system-prompt` 渲染，官方注册表在桌面部署里只有三个变量，
  都由官方 agent loop 注册：`provider` ← `agent.options.provider`、`model` ← `agent.options.model`、
  `cwd` ← `agent.session.header.cwd`；变量名必须匹配 `^[a-z][a-z0-9_]*$`。
- **官方遇到没注册的名字直接抛错**（`unknown prompt variable ...`），会把整次组装带崩；
  所以模板必须由插件自己渲染，不能让官方插值器看到我们的 `{{`。
- 官方 `installModelSelection` 是 agent 作用域的 `system-prompt/assemble` 监听器，会用「这一步实际选中的路由」
  覆盖 `variables.provider/model`——这与 `modelRoute.js` 的判据是同一份状态。

## 改了什么

### host

- **新增 `lib/templateFields.js`**：字段表（名字 + 短标签 + 中文注释，静态白名单，不去反射官方注册表）、
  `renderTemplate`（认得的字段 + 非空字符串值才替换，其余原样保留，绝不抛错）、
  `templateValuesOfAgent`（路由明细优先，其次 agent）、`mergeTemplateValues`（官方 variables 里的非空值压过兜底）。
- **`lib/modelRoute.js`**：抽出 `routeOfSelection` / `routeOfSession` / `routeOfAgent`（返回 `{ provider, model }`），
  `modelKeyOf*` 变成它们的薄包装——**规则命中与模板取值现在共用同一条路由判据**。
- **`lib/sessionInjector.js`**：前后缀在**注入那一刻**渲染成成品（构造参数从「模型键」改成
  `(agent) => ({ modelKey, route })`）。注入永久保留，所以字段值之后不会再变，这一条写进了文档。
- **`lib/systemSections.js`**：`assemble` 监听器里用这次组装的 `variables`（缺了才退回路由判据）渲染
  4 个中间锚点 + 有规则改写的 persona 头/尾，并把这些段标成 `interpolate: false`；没配改写的那一侧不动。
- **`lib/settingsApi.js`**：`/state` 多下发一个 `fields`（唯一真源就是 `templateFields.js`，客户端不抄一份）。
- **实现期踩到并修掉的一个坑**（第一版实现里出现、`verify-assemble-render.mjs` 抓到）：渲染时如果按
  「本插件拥有的段名」把**官方头/尾**也算进去，那么**没配规则时也会把官方段标成 `interpolate: false`**
  ——官方 persona 自己的 `{{cwd}}` 就不再被渲染了。现在只有**真被改写**的那一侧才碰，
  没配的一侧原样返回；`verify-host-wiring.mjs` 与 `verify-assemble-render.mjs` 各有一条断言守着。

### client（手写 bundle）

- 快照多一份 `fields`（老 host 没给就不渲染提示条，版本错位不炸）。
- 每个展开的注入点顶部一行字段徽章（`{{model}} 模型名`）+ 一行注释；点徽章插到**最近聚焦的那条规则**的
  光标处，没聚焦过就插到最后一条，一条规则都没有就直接新建一条。
- 规则卡片里对「拼错的小写字段」给一条轻提示（`dshpi-card-warn`）；中文/大写这类不合官方规则的花括号
  当字面文本，不提示。
- 样式只用 `--dsw-*` 变量，`prefers-reduced-motion` 下关掉动效。

### 验收脚本

- 新增 `verify-template-fields.mjs`（纯逻辑 23 条）：字段表、替换规则、原型链名字、三层括号、
  agent 取值与组装期合并。
- `verify-card-render.mjs`：新增徽章渲染、点击插入（含「没规则时新建」）、注释文案、老 host 无字段表、
  拼错提示 8 条；React 替身补上 `useRef`（无 DOM 环境里点徽章走「插到最后一条」的兜底）。
- `verify-host-wiring.mjs`：`/state` 的 fields、中间锚点与 persona 段的渲染、`interpolate: false`、
  官方自己的段不动、取不到值原样保留、退回 agent 值，共 7 条。
- `verify-inject-flow.mjs`：真 SessionStore 跑一轮，断言前后缀里的字段按路由与 `cwd` 渲染成成品、
  拼错字段原样保留、历史里不再有 `{{}}`。
- `client-shape.mjs` / `verify-panel-toggle.mjs`：React 替身补 `useRef`（契约没变）。
- **新增 `verify-assemble-render.mjs`**（真集成）：真 `@deepseek-ai/dsh-system-prompt` + 真 `renderPrompt`，
  10 条断言——中间锚点与改写后的 persona 头里字段落位、**没配改写的官方尾仍由官方插值**（守住上面那个坑）、
  认不出的字段原样留存、没有 agent 时不炸、一条规则都不配时逐字不变。

## 文档

`docs/injectFormat.md` 新增「模板字段」一节（字段表、渲染时机、取不到值 / 拼错的行为）；
`docs/injectPoint.md` 的约束补一条；`docs/settingGUI.md` 的界面图与说明补提示条；`README.md` 补一节 +
改掉原来「文本里出现 `{{` 按字面处理」的说法；`.agents/checks/README.md` 补脚本与「不覆盖什么」。

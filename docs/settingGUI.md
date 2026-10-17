# 设置 UI 实现

相关：[injectScopeAndSetting.md](injectScopeAndSetting.md)（配置模型）、[injectPoint.md](injectPoint.md)（注入点）。

## 插件形态

一个 npm 包，两半：

- **host**：cordis 插件（`lib/index.js`），持有配置文件、注入逻辑、HTTP 端点。
- **client**：`package.json` 里声明 `dsh.client = { platform: 'web' }`，浏览器半从 `lib/client.js` 出。

依赖声明成 `peerDependencies`。

## 页面挂载

```js
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'promptInject',
  order: 50,
  label: () => 'dsh-prompt-inject',
}, PromptInjectSettings))
```

- 挂官方 `settings.section` 槽位 → 设置导航里独立一项，名称就是插件名。
- 只能注册进官方已声明的槽位；自己声明、或抢注未声明的槽位会在加载时报错。
- UI 复用官方 `@deepseek-ai/dsh-client-ui-primitives`（Button / Switch / Input / Menu / Modal / Tag / Toast）；样式用 `--dsw-*` 设计变量，别写死颜色。0.2.1 起这个包不再随 app 落盘，只作为 web 前端的 baseline 模块存在，浏览器里 `require` 照旧可用。

## 数据通道

host 侧用 `ctx.connection.fetch.register` 在 `/api` 下开端点：

```js
ctx.connection.fetch.register({
  path: '/api/dsh-prompt-inject/state',
  methods: ['GET'],
  requestBody: 'buffered',
  fetch: async (request) => json(await readState()),
})
```

- `/api` 是官方连接层的路由，请求先过 `admit()`（Host/Origin 校验 + 浏览器鉴权）才轮到我们，**鉴权不用自己写**。
- 方法只支持 `GET | HEAD | POST`；`requestBody` 取 `buffered | streaming`。
- 不走官方 typert Remote：那条路要生成产物，运行时不带生成器。

| 方法 | 路径 | 用途 | 请求体 | 响应 |
| --- | --- | --- | --- | --- |
| GET | `/api/dsh-prompt-inject/state` | 规则 + 模型目录 + revision | — | `{ revision, slots, fields, catalog: { providers, degraded } }` |
| GET | `/api/dsh-prompt-inject/catalog` | 只给模型目录 | — | `{ providers, degraded }` |
| POST | `/api/dsh-prompt-inject/rules` | 覆盖写规则 | `{ revision, slots }` | `200 { revision, slots, dropped? }` / `409 { revision, slots }` / `422 { issues, dropped }` |

- `catalog` 由 host 现算：`ctx.llm.listProviders()` → `listModels(provider)`，`key` 用 `"<provider>/<model>"`；某个 provider 拉不到就跳过它并把 `degraded` 置真。
- 目录里**没有「当前模型」**：最近活跃会话在多会话并行时未必是你正在看的那个，切换也未必及时反映，
  界面拿它提示只会误导。所以 `/state` 只说「有哪些模型」和「拉全了没有」，界面也就不显示当前模型。
- 写操作带 `revision` 做乐观锁；对不上回 409，客户端提示并重拉，不静默覆盖。
- 写成功后 host 会立刻刷新 system 段的缓存，不需要额外一步。
- **未知键宽容**：`slots` 里本版本不认识的键（例如旧版客户端的 `system.persona`）就地迁到新键或丢掉，
  记在响应的 `dropped` 里，**不整包 422**。新旧客户端短暂错位时不能把用户卡死在「保存失败」上；
  真正非法的内容（规则字段、模型列表）仍然逐条 422。

## 模型目录什么时候刷新

模型增删改**不用重启 dsh**，也不用刷新页面：host 与界面听的是官方同一套「模型变了」的推送。

| 事件（官方推给浏览器的那几条） | 什么时候响 |
| --- | --- |
| `llm/adapters-updated` | provider 路由增删改（加 provider、改模型列表后适配器重挂） |
| `settings/document-updated` | 任何设置文档落盘（模型设置页就是在写设置） |
| `credentials/record-updated` / `credentials/reference-updated` | 密钥变了，有些模型跟着可用/不可用 |

- **host 侧**（`lib/settingsApi.js`）：事件一响就**丢掉目录缓存**——只丢不清算，没人问就不花这次开销。
  于是客户端紧接着来拉 `/catalog` 时现算，拿到的一定是新目录；30 秒 TTL 只当兜底。
- **客户端侧**（`lib/client.js`）：照同一张表订阅（`ctx.remote.$on`），合并 150ms 后重拉一次 `/catalog`，
  另外在 `connection/reset`（断线重连）后补拉一次。事件表在两边各写一份，`client-shape.mjs` 会对表。
- **只换目录，不动规则**：`/catalog` 单独开一条就是为这个——设置页的规则是本地乐观更新的，
  用户可能正在打字、还没到 500ms 提交，整包重读 `/state` 会把那份编辑冲掉。
- 拿不到 `remote` 服务（极简壳，或网关插件还没挂）时：订阅那部分不激活，设置页照旧能开，
  退回「打开页面时拉一次」的旧行为。老 host 没有 `/catalog`（回 404）时也是留着旧目录，不报错。

## 数据模型

配置文件：`dshHomePath('dsh-prompt-inject', 'rules.json')`，host 是唯一读写者。

```json
{
  "version": 1,
  "revision": 12,
  "slots": {
    "user.prefix": {
      "rules": [
        { "id": "r1", "enabled": true, "text": "总是用中文回答",
          "models": { "all": true, "list": ["deepseek-account/deepseek-flash"] } }
      ]
    },
    "user.suffix": { "rules": [] },
    "system.personaHead": { "rules": [] },
    "system.personaTail": { "rules": [] },
    "system.beforeTools": { "rules": [] },
    "system.afterTools": { "rules": [] },
    "system.middle": { "rules": [] },
    "system.last": { "rules": [] }
  }
}
```

- 规则在列表里的位置就是拼接顺序；`id` 是页内身份（新增时随机生成），host 只校验同注入点内不重复。
- `slots` 的键就是 [injectPoint.md](injectPoint.md) 的注入点表；**每个注入点都只是一串规则**，没有例外（persona 的头与尾是两个独立键）。
- `models.all` 保留 `list`（「全部」不清空其它勾选就是靠它）。
- `version` 是结构版本；`revision` 每次写入 +1。
- 文件坏掉或版本不认：改名成带时间戳的 `rules.json.<时间戳>.bad` 留现场，用空配置继续跑，不静默清空。
- 写入用「读-改-写」加跨进程文件锁，落盘走原子替换，权限 `0600`。

## 界面

设置面板里新增一项「dsh-prompt-inject」：

```
dsh-prompt-inject                                                  [● 已保存]
─────────────────────────────────────────────────────────────────────
 用户消息                                     插在用户输入前后，各自是一条独立 user 消息
 ▸ 用户前置词                                        还没有规则
 ▾ 用户后置词                                            [2 条]
   模板字段： [{{model}} 模型名] [{{provider}} 提供方] [{{cwd}} 工作目录]
   {{model}} 这次请求实际用的模型 id（如 deepseek-flash）…  ·  {{cwd}} 当前会话的工作目录绝对路径…
   [开关] (全部)                                    ↑ ↓ │ ⧉ ✕
   ┌ 多行输入：总是用中文回答 ────────────────────────────────┐
   [开关] (已应用 3 个模型)                          ↑ ↓ │ ⧉ ✕
   ┌ 多行输入：回答要简洁 ────────────────────────────────────┐
   + 新增规则

 system 段（按在 system 里出现的先后排列）      「替换」=改写官方那一段；「插进」=新加一段
 ▸ system 头部                             [替换] [替换官方 persona 头]
 ▸ 工具说明之前                                [插进] [order 950]
 ▸ 工具说明之后                                [插进] [order 3050]
 ▸ 结构化输出之前                              [插进] [order 9800]
 ▸ system 尾部                             [替换] [替换官方 persona 尾]
 ▸ system 最末尾                              [插进] [order 10300]
   （每个注入点一个可折叠小节；有规则的默认展开，点一下能收起）
```

- 顶部常驻：**保存状态**（`保存中 / 已保存 / 保存失败`）。**不显示当前模型**——多会话并行时那个值不可信，
  而且规则按 `provider/model` 匹配这件事，看卡片上的作用域结论和弹层就够了。
- 页面分两组：**用户消息**（前置词 / 后置词）与 **system 段**；system 组内按注入点在 system 里
  出现的先后排（头 0 → 950 → 3050 → 9800 → 尾 10200 → 10300），**头与尾不挨着**。
- 每个 system 小节带一枚模式标签：`替换`（改写官方已有那段）或 `插进`（在段位新加一段），颜色区分。0.2.1 起官方 persona 尾默认是空串，`system 尾部` 仍按「替换」显示——语义没变，只是替换前本来就是空的。
- **折叠**：默认「有规则就展开」，但**用户点过之后以用户为准**（所以有规则的小节也能收起来）。
  实现上是一个 `panels: { [注入点键]: boolean }` 的显式覆盖表，而不是「只记住当前打开的那一个」。
- 空规则时给一句引导，不要只留空白。
- 每个注入点都是一样的形状（一串规则），界面不出现「二合一」这类说法。
- **模板字段提示条**：每个**展开的**注入点顶部一行字段徽章（`{{model}} 模型名` 之类，点一下把
  `{{字段}}` 插到**最近编辑过的那条规则**的光标处；还没点过输入框就插到最后一条；一条规则都没有时
  直接新建一条，内容就是那个字段），下面一行是各字段的注释（来自字段表的 `note`）。
  字段表由 host 从 `lib/templateFields.js` 经 `/state` 下发，客户端**不抄一份**；老 host 没给字段表时
  这一条不渲染（新旧版本短暂错位也不能炸）。可用的字段与语义见 [injectFormat.md](injectFormat.md) 的「模板字段」。
- 规则正文里**拼错的小写字段**（`{{modle}}`）在卡片里给一条轻提示（`dshpi-card-warn`），保存不拦；
  写中文、大写这类不合官方规则的花括号当字面文本，不给提示。
- **小节里可以带一条提醒**（`notice`）：展开时显示在规则列表上方，是一整行会换行的提示块，
  不用小节的 `hint`（那行是单行省略，长文案会被切掉）。当前只有「用户前置词 / 用户后置词」用它，
  内容就是那句「注入后不会自动清除、会一直留在历史里」的提醒——用户必须在这里就能看到这个代价。
  提醒文案与 `lib/injectPoints.js` 的 `notice` 逐字一致（`client-shape.mjs` 会对表）。
- **规则卡片头部只有一行**：开关 · 模型结论（整块可点，直接进作用域配置）· 右侧图标动作
  `↑ ↓ │ ⧉ ✕`（上移 / 下移 / 复制 / 删除，每个都带 `title` 与 `aria-label`）。
- **规则卡片不显示文本摘要**（正文就在下面的输入框里，摘要没有信息量），也不列具体模型键——
  模型作用域只给一句结论：`全部` / `已应用 N 个模型` / `无应用`，失效的另挂一枚 `已失效 N` 标签；
  `无应用` 用虚线圈出，一眼看出这条没生效。
- 样式只用 `--dsw-*` 设计变量，动效克制（120ms），并在 `prefers-reduced-motion` 下关闭。

## 规则卡片

| 元素 | 行为 |
| --- | --- |
| 顺序 | 右侧的 **↑ / ↓ 图标按钮**（官方 UI 库没有拖拽原语），首尾自动禁用 |
| 启用开关 | 关掉即不参与拼接，仍留在列表 |
| 文本 | 多行输入框（卡片唯一的主体），占位「这段文字会按顺序拼进该注入点」；不另做标题/摘要 |
| 模型 | 一枚可点的结论胶囊：`全部` / `已应用 N 个模型` / `无应用`；失效的另挂 `已失效 N`。点它（或右键动作里的任意入口）开弹层多选 |
| 删除 | **✕ 图标按钮**，删掉后 Toast 给一次「撤销」，点撤销会放回**原来的位置** |
| 复制 | **⧉ 图标按钮**，复制一份插在它后面 |

同一注入点内按列表顺序从上到下拼接；不同注入点互不影响。

卡片头部就一行：`开关 · 模型结论 · 弹性空白 · ↑ ↓ │ ⧉ ✕`。图标按钮都带 `title` 与 `aria-label`；
头部 `flex`，窄窗口下不会把按钮挤成竖排。

## 模型作用域

- 弹层里 `全部` 与各模型同列，按 provider 分组（组标题吸附）、带搜索。
- 目录没拉全（`degraded`）时列表最上面给一句说明：没列出来的模型会显示成「已失效」，免得用户以为规则坏了。
- 点「全部」**不清空**其它勾选：勾上 = 匹配所有模型（含以后新增的）；取消后，之前勾的模型继续生效。
- **失效模型**：存的 key 在当前目录里找不到 → 置灰标「已失效」，保持勾选等用户取消；取消前按**不匹配**处理（不注入）。host 侧同一套规则，界面与行为保持一致。
  目录是实时刷新的（见上面「模型目录什么时候刷新」），所以模型删掉、改名之后，「已失效」会当场冒出来，不用重启宿主去找它。
- 没勾「全部」也没选模型 = 不生效，卡片上胶囊显示「无应用」并给一句轻提示（具体模型键只在弹层里看，卡片不留）。
- 入口有三个，都是同一件事：点卡片上的胶囊、点胶囊里的任意文字、从「模型作用域」动作进。

## 保存

- 编辑后 500ms debounce 自动提交；顶部显示「保存中 / 已保存 / 保存失败」。
- 客户端本地乐观更新，写失败或 409 回滚到服务端最新值并提示。
- 不做显式「保存」按钮。

## 待定

1. 界面文案先中文；注入点名、模型名保持英文原样。
2. 要不要在每个注入点加「当前模型下最终拼成什么」的预览区（实现便宜，页面会长一点）。（**暂不做**）
3. 首次安装的空态文案。
4. 真机验证：`/api` 端点在桌面壳与网页壳里的鉴权行为是否一致。
5. 拖拽排序（现在用上/下按钮）。

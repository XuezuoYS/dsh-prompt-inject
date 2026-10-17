# dsh-prompt-inject 实现任务书

> 规格以 `docs/` 为准，本文只讲「怎么做」和「怎么验收」。
> 目标版本：DSH **0.2.0-rc.2**（本机 desktop 发行包）。

## 0. 目标

一个 DSH 插件：在设置页让用户按「注入点 → 多条规则」配前后缀，规则可启用/排序/按模型生效；发送时：

- **用户前后缀**：每轮只注入一次、整轮保持、下一条用户输入到来前还原成原文；UI 上永远只显示用户原文。
- **system 注入**：按注入点插进 system 的不同段位，头尾那一项是「二合一」。

## 1. 必读材料

| 文件 | 用途 |
| --- | --- |
| `AGENTS.md` | 命名（camelCase 函数/变量/文件，PascalCase 类）、模块化、禁止 git 操作、禁止改 AGENTS.md |
| `docs/injectPoint.md` | 注入点表、system 段位 order、注入机制与约束（**规格**） |
| `docs/injectScopeAndSetting.md` | 配置模型：注入点 → 规则列表、模型作用域（**规格，用户维护，别改**） |
| `docs/injectFormat.md` | 注入格式要求（**规格，用户维护，别改**） |
| `docs/settingGUI.md` | 设置页实现：槽位、数据通道、数据模型、交互（**规格**） |
| `.agents/archive/2026-10-11-injectPoint-research.md` | 为什么这么做、备选方案、实验结论、官方源码索引 |
| `.agents/archive/2026-10-11-verify-*.mjs` | 已验证动作的可运行脚本（照抄逻辑） |

> ⬛ **本文书已归档**：任务已完成，实施记录见 [2026-10-11-impl-notes.md](2026-10-11-impl-notes.md)，
> 验收脚本见 [checks/README.md](../checks/README.md)。下面内容保留原样，只改掉了失效的工具路径。

**看官方源码**：DSH 源码装在 asar 里，用
`node aside-asar-reader.cjs <list|tree|cat|extract> "<asar路径>" "<前缀>" [输出目录]`
读取（仓库根目录的临时工具；`.agents/archive/2026-10-11-asar-reader.js` 是同一份的 CommonJS 老版本，
但仓库根 `package.json` 现在是 `"type": "module"`，那个 `.js` 会被当 ESM，跑不起来）；
asar 在 Windows 桌面版的 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar`（自定义安装目录以实际路径为准）。
解包目录用完删掉，别留在仓库里。

## 2. 交付物

```
dsh-prompt-inject/
├─ package.json          dsh.bundle.patch + dsh.client + engines.dsh + peerDependencies
├─ cordis.patch.yml      挂载声明
├─ README.md             给用户看的：装什么、怎么配
└─ lib/
   ├─ index.js           host：装配与注册
   ├─ client.js          client：设置页（手写，不上构建链）
   ├─ configStore.js     读写 rules.json（原子写、revision、坏文件改名）
   ├─ ruleResolver.js    「注入点 + 当前模型」→ 该注入点这次的文本
   ├─ sessionInjector.js agent/pre-step 注入与还原
   ├─ systemSections.js  system 段注册 + assemble 改写
   └─ settingsApi.js     /api 端点（读状态、写规则）
```

## 3. 跑起来

1. 写好后装进 desktop profile：GUI「设置 → 插件」里用本地 link 安装，或 CLI
   `dsh plugin --profile desktop add link:<本目录绝对路径>`（以实际 CLI 帮助为准）。
2. 装完在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 里应能看到本插件的条目（**不要手改这个文件**，交给插件管理器）。
3. 调试：host 半看 DSH 日志；client 半看浏览器控制台。
4. 改动 `lib/client.js` 后刷新页面；host 半改动一般要重启 DSH。**以你观察到的为准**，把结论记进 `.agents/`。

## 4. 官方接口速查（都已验证，照抄）

### 4.1 host 半

```js
// 插件声明
export const name = 'dsh-prompt-inject'
export const inject = ['connection', 'llm', 'systemPrompt', 'agents', 'sessions']
export function apply(ctx) { /* ... */ }

// 配置目录（.dsh/dsh-prompt-inject/）
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
const file = dshHomePath('dsh-prompt-inject', 'rules.json')

// /api 端点：路径必须在 /api 下；鉴权由官方连接层先做（admit()）
ctx.connection.fetch.register({
  path: '/api/dsh-prompt-inject/state',
  methods: ['GET'],                 // 只支持 'GET' | 'HEAD' | 'POST'
  requestBody: 'buffered',          // 或 'streaming'
  fetch: async (request) => new Response(JSON.stringify(state), {
    headers: { 'content-type': 'application/json' },
  }),
})

// 模型目录
const providers = ctx.llm.listProviders()
const models = await ctx.llm.listModels(provider.id)   // → [{ id, name, ... }]
// key 统一用 `${provider}/${model}`

// system 中间锚点：全局 section + 函数式 text（按 context.agent 求值）
ctx.systemPrompt.section({
  name: 'prompt-inject:beforeTools',
  order: 950,
  text: (context) => resolveText('system.beforeTools', context.agent),
})

// system 头尾：全局 assemble 监听器改写官方两段（不能注册同名段！）
ctx.on('system-prompt/assemble', async (assembly, context, next) => {
  const assembled = await next()
  const head = resolveText('system.persona.head', context.agent)
  const tail = resolveText('system.persona.tail', context.agent)
  if (head === '' && tail === '') return assembled
  return {
    ...assembled,
    sections: assembled.sections.map((s) => {
      if (head !== '' && s.name === 'deployment:persona-prefix') return { ...s, text: head }
      if (tail !== '' && s.name === 'deployment:persona-suffix') return { ...s, text: tail }
      return s
    }),
  }
})

// 每轮注入（最外层监听）
ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
  const decision = await next()
  if (decision.kind === 'reject') return decision
  if (!messages.some((m) => m.source?.kind === 'user')) return decision   // 工具循环：不新增
  retireInjected(agent.session)                                          // 先还原遗留
  // 在人类消息前后各插一条独立 user 消息，然后返回 { ...decision, messages }
}, { prepend: true })

// 落库与还原
import { createUserMessage } from '@deepseek-ai/dsh-llm'
const injected = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'prompt-inject' } })
session.append('user/message', injected, { surfaceOp: 'append' })
// 还原：一次范围替换，三条 → 一条原文
session.append('user/message', createUserMessage({ content: original.content, source: original.source }), {
  surfaceOp: { op: 'replace', startSeq: prefixSeq, endSeq: suffixSeq },
  sourceEventSeqs: [prefixSeq, originalSeq, suffixSeq],   // 必须列全，少一个报错
})
```

### 4.2 client 半

`lib/client.js` 必须是这个形状（官方客户端包就是这么产出的，**手写即可**）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-prompt-inject',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')       // 没构建链，直接调 jsx，别写 JSX
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const API = '/api/dsh-prompt-inject'
    // fetch(`${API}/state`) / fetch(`${API}/rules`, { method: 'POST', ... })

    function Settings(props) { /* 页面组件 */ }

    const inject = ['slots']
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'promptInject',
        order: 50,
        label: () => 'dsh-prompt-inject',
      }, Settings))
    }
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
```

`package.json` 照官方 `@deepseek-ai/dsh-client-ui-settings-web-search/package.json` 填，关键是：

```json
{
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-primitives"] }
  },
  "engines": { "dsh": "0.2.0-rc.2" },
  "peerDependencies": { "@deepseek-ai/cordis": "~4.0.4", "@deepseek-ai/dsh-llm": "0.2.0-rc.2", "...": "需要的官方包" }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-prompt-inject
      name: dsh-prompt-inject
```

## 5. 分阶段实施（每阶段都能独立验收）

| 阶段 | 做什么 | 验收 |
| --- | --- | --- |
| **0 打通链路** | 包骨架 + 挂载 + 一个能返回 `{ok:true}` 的 `/api/dsh-prompt-inject/state` + 一个只显示「hello」的设置页 | 设置导航出现 `dsh-prompt-inject`；页面能显示；浏览器 `fetch('/api/dsh-prompt-inject/state')` 返回 ok |
| **1 配置读写** | `configStore` + `/state` 返回全量 + `POST /rules` 覆盖写（revision 乐观锁、原子写、坏文件改名） | 手工 POST 后 `rules.json` 出现在 `.dsh/dsh-prompt-inject/`；刷新页面能读回；故意写坏文件能自愈 |
| **2 用户前后缀** | `sessionInjector`：注入 / 整轮保持 / 下一轮前还原 / 残留自愈 | 见第 7 节验收清单的头三条 |
| **3 system 注入** | `systemSections`：中间锚点用全局 section；persona 头尾用 assemble 改写 | 配了规则后 system 里出现在正确位置；没配时官方默认 persona 原样保留 |
| **4 设置页成型** | 分区、规则卡片、模型多选、失效置灰、debounce 自动保存、状态提示 | 全新会话里从零配一条规则并生效 |

**先做阶段 0**：`/api` 端点与 client 半能不能加载是这个方案最大的未知，别写完一堆逻辑才发现链路不通。

## 6. 关键细节与坑

1. **依赖必须声明成 `peerDependencies`**。装成本地依赖会出现两份模块，`instanceof`、模块私有 WeakSet 全失效。
2. **不能注册 `deployment:persona-prefix` / `-suffix`**。桌面 agent preset 已经挂了官方 `dsh-persona`，同一作用域重名注册会被**静默拒绝**（fiber 进失败态，不抛错）。头尾只能走 `system-prompt/assemble` 改写。
3. **作用域 ctx 上不能直接访问 `ctx.systemPrompt`**（`cannot get property … without inject`）。system 注入一律全局注册 + 用 `context.agent` 区分会话。
4. **注入消息的 `source.kind` 不能是 `user`**，否则会被客户端画成用户气泡；用 `prompt-inject`。
5. **不要改用户那条消息本身**，它是聊天记录的真源；前后缀必须是独立消息。
6. **范围替换的 `sourceEventSeqs` 必须列全**被遮蔽的 seq，少一个直接抛错。
7. **触发规则**：`agent/pre-step` 只在认领到 `source.kind === "user"` 的消息时才动手；否则什么都不做（工具循环不能撤掉本轮注入，也不能重复注入）。
8. **还原点放在「下一条用户输入到来时」**，不要放 `agent/turn-stopping`（它会被 Stop hook 续命）。
9. **残留自愈**：靠扫 surface 上 `source.kind === 'prompt-inject'` 的节点判断，不依赖内存状态，重启也能自愈。
10. **`/api` 端点只支持 `GET | HEAD | POST`**；写用 POST。
11. **不要引 typert Remote**：那条路要生成产物，运行时不带生成器。
12. **配置只写 `.dsh/dsh-prompt-inject/`**：不要把规则塞进 profile 的 `cordis.patch.yml`。
13. **system 段文本为空会被官方丢掉**，所以「没配」= 返回空串即可，不用特判。
14. 段文本里的 `{{变量}}` 必须已注册，否则渲染报错；普通文案里别写 `{{`。

## 7. 验收清单

功能（发一条消息 + 让模型调一次工具 + 再发一条，抓 provider 请求体或看会话日志）：

- [ ] 第一条请求里，用户输入是 `{前置词}原文{后置词}`（三条连排 user 消息，DeepSeek adapter 会合并）
- [ ] 工具循环那条请求里，前后缀**还在**且没有出现第二份
- [ ] 第二条用户消息的请求里，上一轮已还原成原文，只有新输入带前后缀
- [ ] 会话日志里 `user/message` 的 append 真源一条没丢
- [ ] UI 里用户气泡始终是原文，多出来的是 `prompt-inject` 上下文卡片

system：

- [ ] 配了 `system.persona` 的头 → 官方 persona 头被替换；尾没配 → 官方尾原样保留
- [ ] 配了中间锚点（如「工具说明之前」）→ 落在正确段位（对照 `docs/injectPoint.md` 的 order 表）
- [ ] 全都不配 → system 与装插件前**完全一致**

规则与界面：

- [ ] 启用的规则按顺序拼接；关掉的规则不参与
- [ ] 规则只对勾选的模型生效；勾了「全部」对所有模型生效；取消「全部」后原来勾的模型继续生效
- [ ] 失效模型置灰标「已失效」，取消勾选前不参与注入
- [ ] 两个窗口同时改，后提交的收到 409 并提示，不静默覆盖
- [ ] 保存状态正确显示（保存中 / 已保存 / 失败）

不许破坏：

- [ ] 卸载/禁用本插件后，DSH 行为与装之前一致
- [ ] 不影响其它插件（尤其 `dsh-persona`、`dsh-agent-instructions`）
- [ ] 不再产生多余的注入卡片或空消息

## 8. 已知风险（先在阶段 0 验掉）

1. **`/api` 端点在桌面壳与网页壳里是否都通**（`/api` 的鉴权两处行为是否一致）。
2. **`dsh.client` 半能否被加载**（`dsh.client.inject` / `dsh.client.external` 字段填得对不对；报错就回来查这两个字段）。
3. **版本兼容判定**：插件管理器安装前会检查插件声明的 DSH peer 是否与运行时兼容（`engines.dsh` 只是个补充声明）。
   精确版本最保险但每次 DSH 升级都要改；写宽一点更耐用。先按精确版本跑通，再决定放宽到哪。
   参考：运行时里所有官方包都是 `0.2.0-rc.2`。

## 9. 交付后要做的

1. 把 `.agents/` 下的工作文件整理、压缩、归档成日期文件名（`2026-10-11-*` 这种），本任务书完成后再归档。
2. 如果实现时改了设计（比如槽位、端点路径、数据模型），**同步更新 `docs/`**；`docs/` 与 `.agents/` 冲突时以 `docs/` 为准。
3. 给用户写一份 `README.md`：怎么装、怎么配、每个注入点在哪儿、有哪些已知限制。

# host 半适配 0.2.1-rc.2 :: 契约核对 + 兼容门槛 + live 激活

结论：**host 半代码不用改**。0.2.1 没有动插件依赖的任何一个契约；不加载只有一个原因——旧 `engines.dsh`
被 app-boot 的兼容门槛拦掉，整个 bundle 在组合阶段被跳过（不是「装上但禁用」，是连 loader 行都没插进去）。
package.json 修好后，跑一次 profile 重新组合就能不重启激活。

证据基准：
- 新包 `%TEMP%\dsh-pi\ok-021`（0.2.1-rc.2），旧包 `%TEMP%\dsh-pi\ok`（0.2.0-rc.2）。
- 下面代码行号都指新包；`live` 指 `cordis_inspect_query` 对当前桌面进程的查询结果。

## 1. 兼容门槛（根因）

`dsh-app-boot/lib/index.js:311` `evaluatePluginCompatibility` → `unmetRequirements`（`:279`）：

- 有 `engines.dsh` 就以它**单独**判定，peerDependencies 完全不参与（`:281-287`）；没有才逐个查
  `@deepseek-ai/dsh*` peers。
- 判定用 `semver.satisfies(runtime, range, { includePrerelease: true })`（`:276`），所以精确写
  `0.2.1-rc.2` 就能过，`0.2.0-rc.2` 过不了。
- bundle 层的检查在 `loadProfileDirectory`（`:1015-1055`）：不兼容的 bundle 被塞进 `skippedBundles`，
  **它的 cordis.patch.yml 根本不读**，自然也没有 `include:dsh-prompt-inject` 这一行。
  live 侧对得上：`Config.listConfigs(name:'dsh-prompt-inject')` 返回空、`plugin_manager list_plugins`
  里没有它。
- 另外还有一处「行级」兜底 `prepareProfileEntries`（`:2305`）：不兼容的行会被标 `disabled: true` 并告警。
  我们这次没走到这里（bundle 层就没了），所以 `set_plugin` 找不到它，别用。

**结论**：`engines.dsh` 保持精确 `0.2.1-rc.2`。不建议写范围——这个门槛就是防止 rc 之间静默不兼容，
写成 `^0.2.1-rc.2` 等于把下一次 rc 的破坏性变更放进来。每次升 rc 时和 peer 一起改一个版本号即可。

用新包的 `evaluatePluginCompatibility` 实跑了 profile 里的 10 个 bundle（临时探针，已删）：
**全部 OK，包括 `dsh-prompt-inject @ 0.2.0`（engines.dsh=0.2.1-rc.2）**。也就是说重新组合时
只有这一个 bundle 会被追加，别的层不会被顺带踢掉。

## 2. 逐项契约核对（都没变）

| 契约 | 结论 | 证据 |
| --- | --- | --- |
| `systemPrompt.section({name, order, text})` | 同签名、同语义：`text` 可以是函数，`interpolate`/`complete` 可选；注册/销毁都会 emit `system-prompt/change` | `dsh-system-prompt/lib/index.js:253-256`；live inspect `systemPrompt.section(section: PromptSection)` |
| system 段位 order | `SECTION_ORDERS` 与 0.2.0 逐项一致（persona 头 0、尾 10200、结构化输出 9900…）；插件用的 950/3050/9800/10300 落位不变。新增的 HARNESS_SOURCE=10000 / WEB_SURFACE=10100 只插在中间，不影响「末尾段最大」 | `dsh-system-prompt/lib/index.js:10-45` |
| `system-prompt/assemble` | waterfall `(assembly, context, next)` 不变；`PromptAssembly={sections,contexts,tools,variables}`、`AssembledSection={name,text,interpolate?}` 不变；插件「await next() 之后改 sections」照旧生效 | `dsh-system-prompt/lib/index.js:356-405`（waterfall 在 `:398`）；live inspect 事件契约 |
| 组装上下文里的 `context.agent` | 类型声明里 0.2.1 把 `AssembleContext` 收成 `{scope?,signal?}`，**但运行时仍传 agent**：`assembleContextFor` 返回 `{agent, scope, signal?}`，agent-loop 就是拿它调 `assemble()` | `dsh-agent/lib/index.js:291-297`、`dsh-agent/lib/types/dispatch.js:92-94`、`dsh-agent-loop/lib/index.js:907` |
| `agent/pre-step` | 同 waterfall：payload `{agent, messages, turn, step, signal}`，next → `PreStepDecision = {kind:'reject'} \| {kind:'enter', messages, startsRequestSeries?}`。插件 `{...decision, messages}` 不会丢 `startsRequestSeries` | `dsh-agent-loop/lib/index.js:909-921`；live inspect 事件契约 + 类型声明 |
| 官方模型切换提示 | 文案前缀仍是 `[model changed:`，source.kind 仍是 `model-selection`、`form:'notice'`（插件按文案前缀识别，不受影响） | `dsh-agent/lib/index.js:133-147` |
| `createUserMessage` | 实现逐字相同（补 `role:'user'` + 新 uuid + 深冻结），`source` 里的自定义 `kind:'prompt-inject'` 不被校验 | `dsh-llm/lib/index.js:59-63`；`dsh-session/lib/index.js` `validateSessionEventData` 只约束 developer/tool，不查 user source |
| surface 操作 | `SurfaceOp = 'append' \| {op:'replace', startSeq, endSeq}`（恰好 3 个键），`sourceEventSeqs` 必须覆盖全部被遮蔽节点——插件一直这么传；`Session.append(type, data, intent)`、`surface.nodes`、`eventAt`、`deriveMessages`、内部字段 `derivedNodes` 都在 | `dsh-session/lib/index.js:157`（SURFACE_EVENT_TYPES）、`:293-331`（replace/源事件校验）、`:1651,1672-1685`（derivedNodes/deriveMessages） |
| `connection.fetch.register` | 同形状 `{path, methods, requestBody, fetch}`；精确路由只要求 path 在 `/api` 下、methods 非空不重复；路由 handler 仍只拿 `request`（新代码内部 `route.fetch(request)`） | `dsh-client-connection/lib/index.js:732-734`（fetch 门面）、`:973-979`（校验）、`:831`（调用）、`:840-855`（注册/去重） |
| `dsh-home-paths` | `dshHomePath(...segments)` 不变；新增的是 agents-home 那套（我们用不到） | `dsh-home-paths/lib/index.js:132,168` |
| `dsh-atomic-write` | `writeFileAtomic(filename, content, {mode, dirMode})`、`withFileLock(filename, op, {waitMs})` 签名不变；内部只是 sleep 改成可 abort | `dsh-atomic-write/lib/index.js:62-75,189-200,220` |
| 目录失效四条事件 | `API_REMOTE_FORWARDED_EVENTS` 仍含 `llm/adapters-updated`、`settings/document-updated`、`credentials/record-updated`、`credentials/reference-updated`，都是 `mode:'emit'` | `dsh-api-remotes/lib/index.js:21,68,72,104,128` |
| 模型选择投影 | `sessionProjections.stateOf(session,'modelSelection')` 不变，状态仍是 `{pending,lastUsed}` | `dsh-api-session-controller/lib/index.js:2137-2198`；live `sessionProjections.stateOf` 契约 |
| `inject` 的四个服务 | live 全在：`connection`/`llm`/`systemPrompt`/`sessions`；可选用的 `sessionProjections` 也在 | live inspect Service 目录 |
| 会话格式 | 新旧都是 `SESSION_FORMAT_VERSION = 4`，历史会话不迁移，老注入消息原样可读 | 新旧 `dsh-session/lib/index.js:56` |

## 3. 改了什么（都是文档/测试口径，行为零变化）

1. `lib/templateFields.js`：头部注释与 `cwd` 字段说明改准。0.2.1 官方只注册 `provider`/`model` 两个
   提示词变量（`dsh-agent-loop/lib/index.js:1591-1592`），`cwd` 不再注册（工作目录改由 runtime context
   下发；官方 persona 尾默认也变成了空串）。插件本来就从 `agent.session.header.cwd` 兜底取值，所以只是
   去掉了「官方 persona 尾用的就是它」这种已经不对的说法。
2. `.agents/checks/verify-assemble-render.mjs`：注释分清「0.2.0 的老形状」和 0.2.1 的真形状；
   新增 3 条 0.2.1 形状用例（官方尾为空串 + 只注册 provider/model 时，`system.personaTail` 仍能落位、
   插件仍能从 agent 取 cwd、改写段仍标 `interpolate:false`）。现在 13/13。

## 4. live 免重启激活（没执行，等 Lead 拍板）

**推荐：plugin_manager（不重启、不动文件也能生效）**

```
plugin_manager { action: "set_bundle", target: "dsh-prompt-inject", enabled: true }
```

为什么这样能活：`setBundleEnabled`（`dsh-plugin-manager/lib/index.js:1949`）→ `selectBundle`（`:2280`，
会再跑一次 `evaluatePluginCompatibility`，不兼容就在这里报 `incompatible-version`）→ `bundleRows` 拿到
行 id 当 requiredIds（`:2307`）→ `reload`（`:2360`）→ 有 HMR 时走 `hmr.reconcileProfile(requiredIds)`
（`dsh-hmr/lib/index.js:1320`）→ `readProfilePatches` 重新读 bundle 层（`dsh-app-boot/lib/index.js:1127`，
会重新 `loadProfileDirectory`，这次 bundle 不再被跳过）→ `recomposeProfile`（`:3782`）→ 兼容预检
`prepareProfilePatches`（`:2398`）放行 → 往根 Include 更新生成 → loader 导入 `lib/index.js`、执行
`apply(ctx)`；随后 emit `app-boot/config-reload`（`:3871`）和 `plugin-manager/changed`。
`requiredIds` 的作用：插件起不来就是**失败**，不会假装成功。

预期返回：`changed: false`（profile 里本来就有这个 bundle，文件不会变）＋ `application: "applied"`；
失败会带 `error`/诊断。**注意**：这一步会做一次 loader 局部重组合，但只新增这一个行，现有行（包括当前
会话的 agent）不重启；可以放心在会话里执行。执行时机建议放在一个 turn 结束、没有工具在跑的时候。
如果这个工具被权限拦截，直接走下面的备用方案。

**备用：只碰 profile patch 文件（不经过 plugin-manager）**

往 `C:\Users\xuezu\.dsh\profiles\desktop\cordis.patch.yml` 追加一行注释（内容要变，HMR 靠文件内容
比对决定要不要重组：`dsh-hmr/lib/index.js:856-864`）。HMR 会读 bundle 层并 `reconcileProfile()`
（`:865`），逻辑同上，只是没有 requiredIds——插件起不来只会是 warning，行会留在 inactive。适合不想让
plugin-manager 写 profile 的场合；注释留着无害。

**验证（激活后）**

1. `Config.listConfigs { name: "dsh-prompt-inject" }` 应返回 1 条（status 不是 `inactive`）。
2. `plugin_manager list_plugins` 里应出现 `include:dsh-prompt-inject`，`enabled: true`、`fiberPhase: "active"`。
3. line 里 `Slots.listSubTree { root: "settings.section" }` 应多出 `promptInject` 占位；GUI 设置页出现
   「Prompt 注入」。
4. 配一条规则，下一轮用户消息旁边应出现带 `prompt-inject` 来源的注入消息（injector 的 pre-step 生效）。

客户端半不需要手动刷新：`clientModules` 监听 loader 的 `internal/plugin`，新 fiber 一出现就重算图并
`notifyGraphChanged`（`dsh-client-modules/lib/index.js:545-551,713`），`dsh-client-hmr` 通过
`/plugins/events` SSE 把新图推给浏览器，页面里的 entries controller 自己 `sync(graph)` 加载新 bundle
（`dsh-client-hmr/lib/index.js:117-127,153`、`dsh-client-hmr/lib/client.js:272`、
`dsh-client-modules/lib/client.js:407`）。真没生效就刷新一次页面——只重建前端，不动 host。

**不要做**：重启 GUI / 杀进程（当前会话在里面）；`set_plugin`（这个 bundle 连行都没插进去，会报
unknown-plugin）。

## 5. engines / peer / manifestVersion 建议

- `engines.dsh`：**精确 `0.2.1-rc.2`**（现在的值就对）。理由见第 1 节。
- `peerDependencies`：兼容判定不看它（有 engines.dsh 时被忽略），但 **linked 插件的模块解析要看**：
  app-boot 把 `@deepseek-ai/*` 请求路由到安装目录那一份的条件是「请求方包的 package.json 把它列进
  peerDependencies」（`dsh-app-boot/lib/index.js:1347-1352` `readPeerNames`、`:1676` `routeLinked`）。
  所以 peer 列表别精简；host 半实际 import 的官方包是 `dsh-llm`、`dsh-atomic-write`、`dsh-home-paths`，
  客户端半还要 `dsh-client-ui-primitives`，现在都在表里，保持即可。
- `dsh.manifestVersion`：0.2.1 全量包里没有任何代码读它（grep 过 305 个包，0 命中）；留着无害，
  删了也不影响。
- manifest 未知字段：没有严格 schema，app-boot 只读 `dsh.bundle`，client-modules 只读 `dsh.client`，
  多写的字段被忽略。
- 小提醒（package.json 归 Lead）：插件 `version` 还是 `0.2.0`，而 engines/peers 都是 0.2.1-rc.2。
  兼容判定只用 `name@version` 当豁免键，不影响加载；但建议顺手升到 `0.2.1`，免得后面看日志时混淆。

## 6. 测试

- `node .agents/checks/run.mjs b`：**9/9 通过**。
- `node .agents/checks/run.mjs a`：5/5 通过（顺手确认改模板字段注释/文案没碰坏客户端断言）。
- 兼容探针（临时脚本，已删）：profile 10 个 bundle 全部 `OK`。

## 7. 存疑 / 留给 Lead

- live 激活那一步**没有执行**（按任务约定等 Lead）。`set_bundle` 的整条链路是读源码推出来的，
  唯一没实测的就是在活进程里重组合这一下；建议 Lead 自己执行并按第 4 节验证。
- 文档里还有 0.2.1 已不对的说法（不在我的写作用域）：`docs/injectFormat.md:35`
  （「官方尾 `Your working directory is {{cwd}}.` / 值来自官方 agent loop 注册的变量」）、
  `docs/injectPoint.md:68`（「官方自己的 `{{cwd}}` 还要靠它的插值器渲染」）、
  `docs/settingGUI.md:136`（「替换官方 persona 尾」的说明）。0.2.1 起官方 persona 尾默认空串、
  没有 `cwd` 变量，请 Lead 决定改法。
- `lib/injectPoints.js` 里 `system.personaTail` 的 hint 也提到「官方用于告知当前工作目录位置」，
  但用户看到的文案在 `lib/client.js` 内联表里（host 这份 hint 不下发），我没动，免得两边文案对不上。
- 客户端半（`external`、primitives 不再是独立包、`settings.section` 的 props）归 task-1，不重复。

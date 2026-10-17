# 归档索引

按日期排。这些是**当时的现场记录**，结论可能已被后来的改动推翻——要查权威说法先看 `docs/` 和代码。

## 2026-10-11：第一版落地

| 文件 | 是什么 |
| --- | --- |
| [2026-10-11-implementation.md](2026-10-11-implementation.md) | 第一版实现任务书：架构、模块划分、验收口径 |
| [2026-10-11-impl-notes.md](2026-10-11-impl-notes.md) | 第一版落地记录：踩坑、实测结论、后续线索 |
| [2026-10-11-injectPoint-research.md](2026-10-11-injectPoint-research.md) | 注入点调研：官方段位、备选路线、源码索引（`docs/injectPoint.md` 的背景资料就是它） |
| [2026-10-11-asar-reader.js](2026-10-11-asar-reader.js) | 最早的 asar 读取器（CommonJS，现在直接 `node` 跑不动了，留作参考） |
| [2026-10-11-verify-assemble-waterfall.mjs](2026-10-11-verify-assemble-waterfall.mjs) | 早期探针：`system-prompt/assemble` waterfall 行为 |
| [2026-10-11-verify-global-per-agent.mjs](2026-10-11-verify-global-per-agent.mjs) | 早期探针：全局段 vs per-agent 段 |
| [2026-10-11-verify-mount-timing.mjs](2026-10-11-verify-mount-timing.mjs) | 早期探针：插件挂载时机 |
| [2026-10-11-verify-surface-replace.mjs](2026-10-11-verify-surface-replace.mjs) | 早期探针：surface 的 replace 语义 |

## 2026-10-12：一轮功能调整

| 文件 | 是什么 |
| --- | --- |
| [2026-10-12-keep-injections.md](2026-10-12-keep-injections.md) | 改成「注入永久保留、不再自动清除」的来龙去脉 |
| [2026-10-12-postfix-leak-fix.md](2026-10-12-postfix-leak-fix.md) | 修「上一轮后置词被下一轮读到」；顺带记了 asar 抽包的坑 |
| [2026-10-12-template-fields.md](2026-10-12-template-fields.md) | 模板字段（`{{model}}` / `{{provider}}` / `{{cwd}}`）的设计与实现 |
| [2026-10-12-catalog-live-refresh.md](2026-10-12-catalog-live-refresh.md) | 模型目录实时刷新（增删改模型不用重启 dsh） |
| [2026-10-12-asar-scan.mjs](2026-10-12-asar-scan.mjs) | 在 asar 里按关键字扫文件 |
| [2026-10-12-asar-extract.cjs](2026-10-12-asar-extract.cjs) | 早期抽包工具（现用 `../tools/asar2.cjs`） |
| [2026-10-12-dump-session-range.mjs](2026-10-12-dump-session-range.mjs) | 按 seq 区间 dump 会话事件 |
| [2026-10-12-dump-surface.mjs](2026-10-12-dump-surface.mjs) | 重放 `surfaceOp`，把会话 surface 还原出来看节点顺序 |

## 2026-10-17：适配 DSH 0.2.1-rc.2

| 文件 | 是什么 |
| --- | --- |
| [2026-10-17-host-compat.md](2026-10-17-host-compat.md) | host 半契约逐项核对（含行号）+ 兼容门槛源码分析 + live 免重启激活步骤 |
| [2026-10-17-client-compat.md](2026-10-17-client-compat.md) | 客户端半核对：模块加载形状、primitives 导出/props、`settings.section`、`remote` 事件、热加载链路 |

总结版在上一级：[../2026-10-17-adapt-0.2.1-rc.2.md](../2026-10-17-adapt-0.2.1-rc.2.md)。

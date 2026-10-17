# .agents 目录说明

这是 Agent 的工作区：临时文档、验收脚本、小工具、旧工作记录都放这儿。**交付文档以 `docs/` 为准**，
两边说法冲突时按 `docs/` 来；这里的东西只求好用、能看懂，不保证长期维护。

## 布局

| 路径 | 放什么 |
| --- | --- |
| `checks/` | 现役验收脚本。`npm test` / `npm run test:host` 跑的就是这里；怎么搭官方包环境见 [checks/README.md](checks/README.md) |
| `tools/` | 升级 dsh 时反复用的小工具：`asar2.cjs` 从 app.asar 抽子树、`scan-official-diff.cjs` 对比两版官方包树 |
| `archive/` | 已完成工作的记录，文件名一律带日期；索引见 [archive/README.md](archive/README.md) |
| `YYYY-MM-DD-*.md` | 当前正在做的工作记录。活干完、结论进了 `docs/` 或代码，就挪进 `archive/` |

## 约定

- 文件名以日期开头（`2026-10-17-xxx.md`），一眼能看出是哪天的活。
- 文档简洁、口语化：写结论和证据路径（`文件:行号`），别大段贴代码/贴日志。
- 一次性探针也算工作产物：**先归档再删**，别直接删掉别人的现场。
- 能复用的东西放 `tools/`，别埋在 `archive/` 里。

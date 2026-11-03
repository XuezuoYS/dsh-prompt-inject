# dsh-prompt-inject

这是一个适用于 Deepseek Harness（以下简称 DSH / dsh ）的插件，向用户提供 GUI 下分组的自定义且区分模型的发送 Prompt 注入功能。

本项目目标兼容版本为 dsh 的最新 rc 版本

[Deepseek Harness](https://github.com/deepseek-ai/deepseek-harness)

## 工作约束

为保证安全、可靠的与人类开发者协同开发，你需要遵守以下规范：

- 命名风格：对于函数名、变量名、文件名，默认使用小驼峰 `camelCase` 命名，对于类名，默认使用大驼峰 `PascalCase` 命名。
- 请尽可能保持代码的**模块化、高可维护性、少冗余代码、架构与代码层面低耦合**，若用户无要求，在不影响**模块化、高可维护性、少冗余代码、架构与代码层面低耦合**的前提下，执行*最小修改面*。
- 你需要严谨按照要求和约束，若你对于任意问题不确定、未知或拿不准，认为我的要求模糊的，请先向我提问后得到准确回答后再进行。
- 在 `.agents/` 文件夹（若无请自行创建）下储存 Agent 工作用临时文档、文件和给 AI 查阅的备忘和内容，与 `docs/` 内的文档产生冲突时，以 `docs/` 标准要求。
- `.agents/` 下的 Agent 工作文件在工作完成后需整理、压缩、归档入日期文件名。
- `.agents/` 不会纳入 git 链，因此仅作为临时工作区，**禁止外部引用其中内容**以造成依赖。
- 为保证可维护性，`docs/` 与 `.agents/` 下的文档应保持简洁、通俗、口语化，禁止使用少见、偏僻、翻译腔、AI 常用的难读术语，**全部文档应高效优雅**且便于人类程序员理解，语言风格符合 `AGENTS.md`。
- 未经明确允许，禁止进行 Git 操作（允许只读取类操作）。
- 未经明确允许，禁止修改 `AGENTS.md`。

### 注释

JSDoc + `jsconfig.json` 的 `checkJs`（等价于全库 `// @ts-check`）语义；

函数注释风格参考：

```js
/**
 * 函数描述
 *
 * @default paramB = 'some text', paramI = 123
 * @param {string} paramA paramA的描述
 * @param {string} [paramB] paramB的描述
 * @param {number} [paramI] paramI的描述
 * @returns {any} 返回值描述
 */
function aFunction(paramA, paramB = 'some text', paramI = 123) {}
```

注意：应在全部 @param 前写一行式 @default 可包含多个赋值

类注释风格参考（`export class` 之前**紧挨着**的那一段就是 IDE hover 能看到的唯一一段）：

```js
/**
 * 类描述（一句话摘要）
 *
 * 契约摘要：本类对外承诺的关键行为，一到三行写完；
 *
 * 常用入口：
 * - aMethod: 说明
 * - bMethod: 说明
 * ...
 */
export class AClass {
    /**
     * 方法描述
     */
    static aStaticMethod() {}
}
```

### git

**未经明确指令，禁止操作 git，指令有效期仅一轮内有效**

git 提交使用约定式提交，例：

```
feat: 新功能

- 细节1
- 细节2

```
# 2026-10-12：修「上一轮后置词被下一轮读到」

## 用户报的现象

轨迹页里能看到：第 2 轮的「后置词」上下文卡片，到第 3 轮还挂在「上一轮用户原文」和「本轮用户输入」之间。
用户的原话是「第三轮很显然读到了第二轮的后置词」。

## 怎么坐实的

写了个时间线复刻脚本（`.agents/checks/verify-timeline.mjs`），用**真实 SessionStore + 真实插件**跑三轮，
把每轮 `deriveMessages()` 打出来。修之前的样子：

```
第 2 轮 step 1：[用户输入一] [【后置】] … [【前置】] [用户输入二] [【后置】]
第 3 轮 step 1：[用户输入一] [【后置】] … [用户输入二] [【后置】] … [用户输入三]
```

也就是说：**上一轮的后置词没有随轮次退场，作为独立 user 消息永远留在历史里**，
而且紧挨在下一轮用户输入前面——模型的视角里那就是「用户后来又补了一句」。
README 原来写的「留着也等价于 `{前}原文{后}`，不会被带偏」这个假设是错的，已改。

## 根因

`planRestore` 的分组只把「前缀」那条算进还原区间（`{前缀}→{原文}`），
后缀落单，走进「没被算进还原范围的注入节点」分支，而那个分支又有个 `hasEarlierUser` 护栏
（前面有用户原文就留着不管）——于是后缀永远留下了。

## 改法（`lib/sessionInjector.js` 的 `planRestore`）

1. 分组时要求**相邻且同轮**（`sameTurn`）；跨轮绝不合组，否则会把中间那条原文一起吞掉。
2. 每组的右端：吸收跟它**同轮**的注入节点（就是后缀），直到遇到用户原文收尾；
   遇到「别的轮的注入」或普通消息就放弃这一组。
3. 没被认领的注入节点一律整段删掉（去掉原来那个 `hasEarlierUser` 护栏）——
   它们都是原文已经被压缩/遮蔽的孤儿，留着就会继续污染后面的轮次。

结果：`前缀 + 原文 + 后缀` 一次性压回原文，历史里只留一条空内容占位消息
（DeepSeek 适配器显式跳过空 user 消息，不会发出去）。

## 第二次修：真机上仍然漏（下半场）

第一版改完、离线全绿，但真机第 3 轮**照样读到了上一轮的后缀**。后面查出两条真原因，
第一版之所以看着能过，是因为离线脚本喂进去的 surface 排列比真机「干净」。

### 根因 A：拿事件号当位置用

真机 surface 的排列是「**原文在前、注入在后**」（插件给官方的 `messages` 是 `[原文, 后缀]`，
原文那条的事件号还更小）。而 `applyRestore` 当时是 `nodes.indexOf(fromSeq/toSeq)` 拿事件号找位置，
号大的在左、号小的在右时 `startIndex > endIndex`，直接 `return false` ——
**计划好的还原被静默丢弃**，只剩 drops 兜底，后缀原封不动留下。

修：区间一律按 **surface 位置**给出与执行，不再用事件号。

### 根因 B：摘要下标与 surface 下标错位（最阴的一条）

`summarizeSurface` 把非 `user/message` 的节点压成 `null`，`planRestore` 又 `filter` 掉了 null。
surface 里绝大多数节点都是非 user/message（指令 / 运行上下文 / 助手 / 工具结果），
于是「摘要下标」根本不是「surface 下标」，按位置算的区间整体错位——
`applyRestore` 读到的「原文」其实是别的节点，安全校验失败，还原再次落空。

修：`planRestore` 不再压缩数组（null 位保留占位），位置严格等于 surface 下标。

### 兜底：还原落空也必须把注入清掉

`applyRestore` 校验不过时不再静默返回 false，而是退一步**只抹掉那段里的注入节点**
（`dropInjections`，绝不碰用户原文）。宁可多一条空占位，也不许注入留在历史里。

### 最终判据长什么样

- 每轮把注入按轮次分组（同轮前缀/后缀可能不相邻）；
- 从右往左处理（新轮次先认领原文，老注入抢不走）；
- 锚点 = 组内或就近的那条用户消息，且它与组之间只有注入/切换提示；
- 锚点找不到 → 只删这组注入；找到 → 一次替换把「原文 + 组 + 沿途注入」压回原文。

## 验收

- `.agents/checks/verify-no-postfix-leak.mjs`：多轮断言任意一轮上下文里只有本轮前后缀 → 11/11。
- `.agents/checks/verify-logic.mjs`：改成按下标断言，覆盖「原文在前 / 原文在后 / 串轮 / 压缩孤儿」
  等 9 种排列，并逐条断言**删除区间绝不碰用户原文** → 46/46。
- `.agents/checks/verify-inject-flow.mjs`：加了「真机排列 + 非 user 节点撑开下标」的回归用例 → 23/23。
- 其余（client-shape / card-render / panel-toggle / model-route / config-store / host-wiring / derived-cache）全绿。
- `.agents/checks/verify-timeline.mjs`：肉眼复核多轮历史里已无前几轮注入文字。

## 顺带踩到的坑（值得记）

- 想看官方源码得从 `app.asar` 抽。抽的时候**数据区起点是 `16 + pickledSize - 8`**，
  不是官方 reader 的 `16 + pickledSize`；用后者会把每个文件开头吃掉 8 字节（抽出来的 package.json
  全是 `e": "@deepseek-ai/..."` 这种缺头的样子）。现成读取器：`.agents/tools/asar2.cjs`。
- 抽出来的包要在 `node_modules/@deepseek-ai/` 下再给每个包做一层 junction，
  否则包之间的相互引用（`cordis` → `cosmokit`）解析不到。
- 读取器还会用 `2026-10-12-dump-surface.mjs` 把会话日志的 surface 按 `surfaceOp` 重放出来，肉眼核对节点顺序。

## 让改动生效的正确姿势

host 半改了之后：

- `install_bundle` 对**已安装**的插件只回 `restart-required`，**不重新加载模块**（白装）；
- 要立刻生效：`set_plugin` 把条目先禁用再启用（条目 id 形如 `include:dsh-prompt-inject`），
  这会走一次真正的 HMR 重载（清 ESM 缓存后重新 import）；
- 或者重启 DSH。

新代码有没有真的进进程，看会话日志里有没有出现 `surfaceOp.replace` 事件就能确认。

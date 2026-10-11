# 注入作用域和配置规则

在 GUI 中，采用多条配置、自由选择的模式。分级如下：

- user 前置词
  - rule 1
  - rule 2
- user 后置词
  - rule 3
- system 注入点1
  - rule 4
  - rule 5
  - ...
- system 注入点2
  - ...
- ...

其中每条 rule 用户可自定义顺序和是否启用的开关，注入时每个位置按顺序从上到下，system注入点具体位置参考 injectPoint.md。

其中每条 rule 可自定义作用域模型，模型列表有全部（选中时不自动取消选中其它模型以便于非全部时对应配置生效）和 DSH 内的全部可用模型（可多选）

这份列表跟着 DSH 实时走：在 DSH 里加 / 删 / 改模型，设置页立刻能看到（细节见 [settingGUI.md](settingGUI.md) 的「模型目录什么时候刷新」），不需要重启宿主。

当某一条模型失效时，将其置灰提示“已失效”等待用户取消勾选。

## 算哪个模型

判据只有一个，两条注入路径（user 前后缀、system 段）共用 `lib/modelRoute.js`：

1. **官方的模型选择投影**（`ctx.sessionProjections` 的 `modelSelection` 单元，键 `pending` → `lastUsed`）。
   这是用户在下拉里点的那个模型，也正是官方 `dsh-agent` 的 `installModelSelection` 用来定路由的状态。
2. 拿不到投影（headless 之类没挂这个单元的组合）→ 会话里**最近一次已提交请求**的路由（`session.requestContext()`）。
3. 再退一步 → agent 建立时的 `options`。

system 段还有更准的一层：`system-prompt/assemble` 拿到的组装结果里，`variables.provider / model`
就是这次组装定下来的路由（官方自己写的），头 / 尾改写优先用它。

## 位置

配置文件位置应位于 `.dsh/dsh-prompt-inject/` 文件夹内，.dsh 目录通过 dsh 宿主获取。
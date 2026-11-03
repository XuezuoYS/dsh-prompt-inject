# @xuezuoys/dsh-prompt-inject

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 dsh）的一个插件：在设置页里，按**组**和**模型**配置要注入的提示词。

装好之后，设置里多出一项「dsh-prompt-inject」。页面是一张张组卡片：组有名字、开关、模型作用域，下面排着 8 个注入位置。位置默认关着，点开才能写文字。组的上下顺序，就是同一个位置拼合时的先后顺序。改完自动保存，下一轮对话就用新值。

- 目标适配最新 dsh rc 版本
- 注入的位置分两类：夹在用户输入前后的**前置词 / 后置词**，和 system 里的**六个位置**。
- 同一位置可以由多组一起拼；组还能只对某些模型生效。
- 位置文字里可以写 `{{model}}` 这类模板字段，发送时换成这次请求的真实值。
- 配置文件存在本地，一切改动只影响你自己。

## 安装

用 dsh 自带的插件命令，从 npm 装进你要用的 profile：

```sh
dsh plugin --profile web add @xuezuoys/dsh-prompt-inject
```

`--profile` 填你平时启动的那个 profile：命令行跑 Web UI 就是 `web`，桌面版是 `desktop`。第一次用某个 profile 时，这条命令会先把它初始化出来。新装的组合包默认就是启用的，不用再开。

命令里的 `github:所有者/仓库` 是 pnpm 的简写形式，转发给 profile 目录里的 pnpm 执行。想把版本钉死、不让后面的推送悄悄改变实际跑的代码，就带上 commit：

```sh
dsh plugin --profile web add github:XuezuoYS/dsh-prompt-inject#<sha>
```

也可以直接从 GitHub 装（等价于 npm 版的开发分支）：

```sh
dsh plugin --profile web add github:XuezuoYS/dsh-prompt-inject
```

本插件是纯 JS 的手写包，没有 `prepare`、`install` 之类的构建脚本，所以官方文档里 git 安装那道「授权构建」的坎在这里不存在（pnpm 10 只会拦带构建脚本的包）。

装完如果 dsh 正在跑，命令会告诉你是立刻生效还是要重启；重启一次 dsh 总是安全的。想确认装上了，可以只看配置层而不启动：

```sh
dsh --profile web --dump-config   # 应该能看到一行 "# == @xuezuoys/dsh-prompt-inject"
```

卸载会同时移除依赖和它贡献的配置层：

```sh
dsh plugin --profile web remove @xuezuoys/dsh-prompt-inject
```

卸载不动你的配置文件，重装回来配置还在。

## 设置页里怎么用

打开 设置 → dsh-prompt-inject。页面是一列组卡片，卡片从上到下就是拼合顺序。

第一次装是空的：页面中间显示「还没有注入规则」，点「＋ 新建组」建第一个。新组默认启用、对全部模型生效、8 个位置全关，名字叫「组 N」（N 是当前组数 + 1）。

组卡片头部一行：

| 元素 | 干什么 |
| --- | --- |
| 开关 | 关掉整组不参与注入，位置和文字留着；卡片上标「已停用」 |
| 组名 | 直接改；输入时清空没事，保存时还空着就恢复成上一次保存成功的完整名字 |
| 模型作用域 | 一枚胶囊，写着 `全部` / `已应用 N 个模型` / `无应用`，点它开弹层多选 |
| ↑ / ↓ | 调整组的顺序，首尾自动禁用 |
| ✕ | 删除这个组，先弹窗确认（取消 / 删除）；所有组都能删，删光回到空状态 |

组卡片可以整卡折叠：点组名左侧的小箭头，收起后只剩头部一行（开关、组名、作用域、顺序、操作都还在），再点一次展开。顶栏还有「全部折叠」按钮，一下收起所有组；全部收起后按钮变成「全部展开」。

组里是 8 个位置，顺序固定（用户前置词 → 用户后置词 → system 头部 → 工具说明之前 → 工具说明之后 → 结构化输出之前 → system 尾部 → system 最末尾）。每个位置默认折叠成一行：

- 关着时一行：开关、位置名、一句说明和「已关闭」；system 位置还会带 `替换` / `插进` 标签。
- 打开后出现一个多行输入框，就是这段要注入的文字。
- 位置开着但文字留空 = 这个位置不注入。

底部有「＋ 新增组」。组全删光时页面回到居中的空状态，所有组都能删。

停止输入 20 秒、或者点别处移开输入焦点后自动保存。编辑期间顶部状态栏是黄色「等待编辑结束后保存」；正在提交时是「保存中…」，之后是「已保存 / 保存失败」。开关、上下移动、增删组、作用域勾选这类点击操作会**立即保存**，不会进入等待状态。没有单独的保存按钮，也不需要。写失败或版本对不上时会回滚到服务端的最新值并提示你，不会静默覆盖。

## 注入点

| 设置页里叫 | 键 | 怎么进 system | 落在哪 |
| --- | --- | --- | --- |
| 用户前置词 | `user.prefix` | 插入一条独立 user 消息 | 当前用户输入之前，每轮只注入一次 |
| 用户后置词 | `user.suffix` | 同上 | 当前用户输入之后，每轮只注入一次 |
| system 头部 | `system.personaHead` | 替换官方那一段 | 官方 persona 头（order 0），官方用来说明当前调用的模型名 |
| 工具说明之前 | `system.beforeTools` | 新加一段 | order 950 |
| 工具说明之后 | `system.afterTools` | 新加一段 | order 3050 |
| 结构化输出之前 | `system.middle` | 新加一段 | order 9800 |
| system 尾部 | `system.personaTail` | 替换官方那一段 | 官方 persona 尾（order 10200），0.2.1 起默认为空串 |
| system 最末尾 | `system.last` | 新加一段 | order 10300，排在官方 persona 尾之后 |

每个组在每个位置各有一块文字；同一个位置，所有「组启用 + 作用域命中 + 位置启用 + 文字非空」的组按组顺序用空行拼起来，再注入。

system 那六项的两种做法分得很清楚：

- **替换**（头部 / 尾部）：官方本来就有这两段，插件只把它们的内容换掉。所有组在那一侧拼出来是空的，就保持官方默认（0.2.1 起官方尾默认是空串）。官方段不会因为替换而消失，也不会出现重复的两段。
- **新加一段**（工具说明之前 / 之后、结构化输出之前、system 最末尾）：官方没有对应段落，插件在指定段位加一段。拼出来是空串时这段解析成空串，官方渲染时会直接丢掉，等于不存在，不会覆盖任何官方内容。

细节和官方段位参照表见 [docs/injectPoint.md](docs/injectPoint.md)。

## 用户前置词 / 后置词注入之后不会清除

这是设计决定，也是这个插件唯一需要你提前知道的代价，所以设置页在这两个位置展开后写着这句话。

- 注入的前后缀是**独立的 user 消息**，和你打的原文一样落进会话历史，之后每一轮模型都还能读到。
- 注入之后就再也不动它：不压缩、不清除、不还原，一轮一轮累积下去。
- 上一轮的后置词会夹在上一轮原文和这一轮输入之间，模型很可能把它当成「用户又补充了一句」。所以这两个位置只写不会引起误解的话，比如统一的输出要求；别写带时间、带轮次、带指代的内容。
- 你发的那条消息本身不会被改动，聊天记录仍然是真的。
- 到 provider 那边，连续的 user 消息会被 DeepSeek adapter 合并成一条 `{前置词}原文{后置词}`；pi-ai 那类不合并，就是三条。
- 一轮只注入一次：工具循环的续跑请求不会再加一遍，本轮那份继续保持。

想让某句话只在 system 里生效、不留在用户历史里，就配到 system 的那几个位置去。

## 模板字段

位置的文字里可以写这几个字段，发送时会换成这次请求的真实值：

| 字段 | 换成什么 |
| --- | --- |
| `{{model}}` | 这次请求实际用的模型 id，比如 `deepseek-flash` |
| `{{provider}}` | 这个模型属于哪个 provider，比如 `deepseek-account` |
| `{{cwd}}` | 当前会话工作目录的绝对路径 |

`model` / `provider` 就是官方在用的两个提示词变量（官方 persona 头用的就是 `{{model}}`）。`cwd` 从 0.2.1 起官方不再注册，插件自己从会话头兜底取，效果一样。设置页顶栏左侧有个「模板字段」下拉（里面带每个字段的说明），点一下就把 `{{字段}}` 插进你正在编辑的那个位置输入框。没在编辑时按这个顺序找地方：

1. 最近编辑过的位置（组和位置都还在）→ 插到它记录的光标处；
2. 第一个有文字的组里最后一个有字的位置 → 追加到末尾；
3. 第一组的「用户前置词」→ 自动打开并写入；
4. 一个组都没有 → 先建一个「组 1」，再按第 3 步办。

渲染时机：

- **用户前置词 / 后置词**：注入那一刻就渲染成成品再落进历史。当时是什么就是什么，之后不会再变（注入是永久保留的）。
- **system 六个位置**：每次组装 system 时，先把那个位置按组顺序拼好，再渲染；渲染完这一段标成不再插值，官方的插值器碰不到我们注入的花括号。

认不出来、这次拼错、或者取不到值的字段，`{{名字}}` 会**原样保留**，不报错、也不会让这次请求失败。名字不合法的（中文、大写）一律当普通文本。想真的写出 `{{model}}` 这几个字而不是让它被换掉，写成 `{{ model }}` 或者换个大小写就行。

## 模型作用域

- 作用域设在组上，管这一组的全部 8 个位置。
- 模型键是 `<provider>/<model>`，比如 `deepseek-account/deepseek-flash`。
- 弹层里「全部」和各模型同列，按 provider 分组，带搜索。
- 点「全部」= 对所有模型生效，**含以后新增的**，而且不会清空其它勾选；取消「全部」之后，之前勾的模型继续生效。
- 既没勾「全部」也没选模型，这个组当前不生效，卡片上是 `无应用`（虚线圈出）外加一句轻提示。
- 存过的模型键在当前目录里找不到了，会标成 `已失效` 并保持勾选，等你自己去取消；在你取消之前，它按**不匹配**处理，也就是整组不注入。
- 目录跟着 dsh 实时走：在 dsh 里加删改模型、改密钥，设置页马上就能看到，不用重启 dsh、也不用刷新页面。某个 provider 的目录没拉全时，列表顶部会说一句，那些没列出来的模型就会显示成「已失效」——这不是组坏了。
- 「这一步算哪个模型」只有一套判据：优先官方模型选择投影（就是你在下拉里点的那个），拿不到再退到这次会话最近一次请求的路由，再退到 agent 建立时的选项。system 头部 / 尾部更准一层，直接用这次组装定下来的 provider 和模型。

## 配置存在哪里

`~/.dsh/dsh-prompt-inject/rules.json`（Windows 上一般是 `C:\Users\<你>\.dsh\dsh-prompt-inject\rules.json`，.dsh 文件夹路径由宿主决定）。

写入走原子替换，带跨进程文件锁，权限 `0600`。文件坏掉或者结构版本不认识时，它会带着时间戳改名成 `rules.json.<时间戳>.bad` 留着（现场可查），然后用空配置继续跑，不会静默把你的组清空。这个文件由插件自己读写，建议只在设置页里改。

结构长这样，组数组的顺序就是页面顺序和拼合顺序：

```json
{
  "version": 2,
  "revision": 12,
  "groups": [
    {
      "id": "g1",
      "name": "全局要求",
      "enabled": true,
      "models": { "all": true, "list": [] },
      "positions": {
        "user.prefix": { "enabled": true, "text": "总是用中文回答" },
        "user.suffix": { "enabled": false, "text": "" },
        "system.personaHead": { "enabled": false, "text": "" },
        "system.beforeTools": { "enabled": false, "text": "" },
        "system.afterTools": { "enabled": false, "text": "" },
        "system.middle": { "enabled": false, "text": "" },
        "system.personaTail": { "enabled": false, "text": "" },
        "system.last": { "enabled": false, "text": "" }
      }
    },
    {
      "id": "g2",
      "name": "flash 专用",
      "enabled": true,
      "models": { "all": false, "list": ["deepseek-account/deepseek-flash"] },
      "positions": {
        "user.prefix": { "enabled": false, "text": "" },
        "user.suffix": { "enabled": false, "text": "" },
        "system.personaHead": { "enabled": false, "text": "" },
        "system.beforeTools": { "enabled": false, "text": "" },
        "system.afterTools": { "enabled": false, "text": "" },
        "system.middle": { "enabled": false, "text": "" },
        "system.personaTail": { "enabled": false, "text": "" },
        "system.last": { "enabled": true, "text": "回答完用一句话总结。" }
      }
    }
  ]
}
```

- `groups` 是空数组（零组）也合法，此时不注入任何东西。
- 每个位置块默认 `{ "enabled": false, "text": "" }`；位置开着但文字为空，等于没配。
- `models.all` 为真时 `list` 照样留着，取消「全部」后那些勾选继续生效。
- 组名最多 60 字，位置文字最多 100000 字，一个组最多 500 个模型键，最多 50 组。
- `revision` 每次写入加一，用来挡掉两个窗口同时写的情况。

从 v1 升级：旧文件第一次被读到时，会先复制一份 `rules.json.v1.bak`，再迁成一个默认组（名字「默认组」，全模型）。旧规则在每个位置的文字按顺序合并（停用规则的文字也并进来，不丢字）；位置开关看旧规则里有没有任意一条启用；旧规则各自的模型勾选统一变成全部模型。旧版页面还在提交 `slots` 时，服务端会回 422 并提示刷新页面。完整字段说明见 [docs/userData.md](docs/userData.md)，版本记录见 [docs/userDataUpdateLog.md](docs/userDataUpdateLog.md)。

## 已知限制

- 用户前置词 / 后置词永久留在会话历史里，见上面那一节。
- 设置页不显示「当前模型」。多会话并行时那个值不可信，切换也未必及时反映，拿来提示只会误导。组按 `provider/model` 匹配这件事，看卡片上的作用域结论和弹层就够了。
- 没有「这个位置最终拼成什么」的预览区。目前暂不做。
- 组的排序只有 ↑ / ↓，没有拖拽；位置顺序固定，不能自己排。
- 没有「复制一整组」，要一样的配置只能手动再建一组。
- 模型目录的实时更新只覆盖 dsh 自己推送的变化。直接编辑 dsh 的配置文件、或者远端 provider 自己上下架模型，这边不会自动知道 —— 刷新页面就能拿到新目录。
- 有几道硬上限：最多 50 组，组名最多 60 字，单个位置的文字最多 100000 字，一个组最多勾 500 个模型键。超了保存会失败，并逐条告诉你哪一项有问题，已有的配置不会因此丢掉。
- 设置页文案目前以中文为主，位置键名和模型键保持英文原样。
- 目标版本写死在 `engines.dsh`（现在是 `0.2.1-rc.2`）。dsh 从 0.2.1 起会硬检查这条要求：不满足就把整个 bundle **静默跳过**（只在启动诊断的 `skippedBundles` 里留一条原因，不报错），所以升级 dsh 之后插件「不见了」，第一件事就是改这个值。dsh 还在 developer preview，破坏兼容的改动是常态。

## 开发

一个 npm 包，两半：

- **host**：cordis 插件 `lib/index.js`，管配置文件、注入逻辑、HTTP 端点。组结构、默认值、读取规整和 v1 迁移在 `lib/groupConfig.js`，保存前的字段校验在 `lib/configValidation.js`，按组算某个位置最终注入什么在 `lib/groupResolver.js`。
- **client**：`lib/client.js`，手写浏览器包，不走构建链，由 `package.json` 的 `dsh.client` 声明。

设计文档在 `docs/`，都挺短：

| 文件 | 讲什么 |
| --- | --- |
| [docs/injectPoint.md](docs/injectPoint.md) | 注入点、官方段位、两种语义的由来与约束 |
| [docs/injectFormat.md](docs/injectFormat.md) | 前后缀的注入格式、位置文字里的模板字段与渲染时机 |
| [docs/injectScopeAndSetting.md](docs/injectScopeAndSetting.md) | 组和位置的层级、模型作用域、怎么算「这次是哪个模型」 |
| [docs/settingGUI.md](docs/settingGUI.md) | 设置界面、数据通道（三个 `/api` 端点）、目录刷新的事件表 |
| [docs/userData.md](docs/userData.md) | 数据文件结构、字段、拼合、上限、坏文件与迁移 |
| [docs/userDataUpdateLog.md](docs/userDataUpdateLog.md) | 数据模型版本记录、v1 → v2 迁移 |

动手前值得知道的几件事：

- 注入点表有两份：`lib/injectPoints.js` 是权威的那份，`lib/client.js` 里内联了一份一模一样的（客户端半不能 import）。改表要两边一起改，`tests/client-shape.mjs` 会检查两边是否一致。
- `@deepseek-ai/*` 一律声明成 `peerDependencies`，不能装成本地依赖 —— 那样会变成两份模块实例，`instanceof` 和模块私有的 WeakSet 都会失效。
- 客户端半只在浏览器里 `require('@deepseek-ai/dsh-client-ui-primitives')`。从 0.2.1 起它不再是磁盘上的独立包，而是 web 前端模块表里的 baseline 模块（`require` 照样解析得到），所以 `dsh.client.inject` 里不列它；`peerDependencies` 里那份只是标版本。新版 `dsh.client` 另有 `external`（声明非 baseline 的动态包）和 `immediately`，我们都没用到。
- 端点开在官方 `/api` 下面，鉴权由官方那层处理，插件自己不写；所以只支持 `GET` / `HEAD` / `POST`。
- 校验脚本分两组：`npm test` 跑纯 node 那组（clone 下来就能验，不依赖任何官方包）；`npm run test:host` 跑要官方包那组，没临时解包会直接退出码 2 并打印怎么搭（`npm run test:all` 两类一起）。细节见 [tests/README.md](tests/README.md)。
- host 侧代码改了要重启 dsh；只改客户端那一半刷新页面就行。
- 项目协作规范见 [AGENTS.md](AGENTS.md)。

## 许可

[MIT](LICENSE)

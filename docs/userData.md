# 数据模型

插件把配置存在一个 JSON 文件里，host 是唯一的读写者。平时不用手改，在设置页里点点就行。

## 文件在哪

`~/.dsh/dsh-prompt-inject/rules.json`

Windows 上一般是 `C:\Users\<你>\.dsh\dsh-prompt-inject\rules.json`，`.dsh` 的位置由宿主管。

- 目录权限 `0700`，文件权限 `0600`，只有你自己能读。
- 写入走原子替换：先写临时文件再换名，中途断电不会留半截文件。
- 多个窗口同时写时用文件锁排队，不会互相踩。
- `revision` 每次成功写入加一。提交时带上手里的 revision，对不上就拒绝（409），让页面重读，避免旧内容盖掉新内容。
- 文件坏了或者 `version` 认不出来：改名成 `rules.json.<时间戳>.bad` 留着现场，然后按空配置继续跑。不会悄悄把你的内容清空。

## 整体结构

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
    }
  ]
}
```

| 字段 | 是什么 |
| --- | --- |
| `version` | 结构版本，现在是 `2`。 |
| `revision` | 写入计数，每写一次 +1，用来挡并发。 |
| `groups` | 组数组。可以是空数组（零组），最多 50 组。 |

## 组

组就是一个对象，字段如下：

| 字段 | 是什么 |
| --- | --- |
| `id` | 页面里的身份，新增组时随机生成；同一份配置里不能重复。 |
| `name` | 组名，最多 60 字。输入过程中可以空着，保存时还空就补回这个组上一次保存成功的完整名字。 |
| `enabled` | 组开关。关掉后整组不参与注入，位置和文字原样保留。 |
| `models.all` | 是否对所有模型生效，含以后新增的。 |
| `models.list` | 勾选的模型键，形如 `provider/model`，最多 500 个，会去重。`all` 为真时 `list` 照样留着，取消「全部」后它们继续生效。 |
| `positions` | 8 个位置块，键见下一节。 |

`models.all` 为假且 `list` 为空，表示这个组当前对任何模型都不生效（页面上显示「无应用」）。

## 位置

每个组都有 8 个位置，每个位置就是一个 `{ enabled, text }` 块：

| 键 | 页面上叫什么 | 注入到哪 |
| --- | --- | --- |
| `user.prefix` | 用户前置词 | 用户输入之前 |
| `user.suffix` | 用户后置词 | 用户输入之后 |
| `system.personaHead` | system 头部 | 替换官方 persona 头 |
| `system.beforeTools` | 工具说明之前 | 新加一段（order 950） |
| `system.afterTools` | 工具说明之后 | 新加一段（order 3050） |
| `system.middle` | 结构化输出之前 | 新加一段（order 9800） |
| `system.personaTail` | system 尾部 | 替换官方 persona 尾 |
| `system.last` | system 最末尾 | 新加一段（order 10300） |

- `enabled` 默认 `false`，页面上折叠成一行；打开后才出现输入框。
- `text` 默认空串。位置开着但文字是空的，等于没配，不注入。
- 文本最多 100000 字。
- 缺了哪个位置键，读的时候按默认值补：关、空。

每个位置具体怎么落进 system，见 [injectPoint.md](injectPoint.md)。

## 顺序与拼合

- `groups` 从上到下的顺序，就是设置页里组卡片的顺序，也是同一个位置的拼合顺序。
- 某个位置最终注入什么，按这个流程算：
  1. 从第一组走到最后一组；
  2. 组启用、组作用域命中这次请求的模型、位置启用、文字非空 —— 四条都满足才收；
  3. 收到的文字按顺序用空行（`\n\n`）连起来。
- 一份都没收到：这个位置不注入。system 的「新加一段」位置解析成空串，官方渲染时丢掉；persona 头 / 尾保持官方默认。
- 组与组之间互不影响：组 A 的 `user.prefix` 和组 B 的 `user.prefix` 会拼在一起，但组 A 的 `user.prefix` 不会跑到组 B 的 `user.suffix` 去。

## 零组

`groups: []` 是完全合法的状态，新安装就是这样。零组时文件就长这样：

```json
{ "version": 2, "revision": 0, "groups": [] }
```

- 页面居中显示「还没有注入规则」和一个「＋ 新建组」。
- 零组时什么都不注入，跟「所有位置都关着」效果一样。
- 新建组给默认值：启用、全部模型、8 个位置全关、名字「组 N」（N 是当前组数 + 1）。

## 组名保存

- 输入过程允许清空，不会拦你。
- 保存时（停止输入 20 秒或移开焦点那次）如果还是空，恢复成这个组上一次保存成功的完整名字（不会只剩最后一个字），再提交。
- 组名不要求唯一，两个组可以重名。

## 上限

| 项目 | 上限 |
| --- | --- |
| 组数 | 50（0 组合法） |
| 组名 | 60 字 |
| 单个位置的文字 | 100000 字 |
| 单个组的模型键 | 500 个（会去重） |

超了保存会失败，并逐条说哪里不对，已有的内容不会丢。

## 从 v1 迁移

旧文件是 `version: 1`、按 `slots` 存的。第一次读到它时：

1. 先复制一份 `rules.json.v1.bak`；
2. 把内容换成一个默认组：`id: "default"`、名字「默认组」、启用、全部模型；
3. 8 个位置里，旧规则的文字按顺序用空行合并（停用规则的文字也会并进来，不丢字）；位置开关看旧规则里有没有任意一条启用。

旧规则各自的模型勾选没法搬到组上，迁移后统一是「全部模型」。迁移只在内存里完成，下一次保存才会把文件写成 v2。版本历史和迁移细节见 [userDataUpdateLog.md](userDataUpdateLog.md)。

## 只在设置页里改

这个文件由插件自己读写。手改容易撞上 revision 和格式校验，真出问题还可能被当成坏文件改名归档。要改就在设置页里改。

# 发布流程

发布只走一条路：打 tag → 推到 `release` 分支 → GitHub Actions 自动发。
工作流在 [`publish.yml`](../.github/workflows/publish.yml)，触发条件只有一个：往 `release` 分支推送。

## 一次发布

1. 改 `package.json` 的 `version`。tag 名就是 `v` 加上这个版本号，必须一字不差。
2. 提交，然后打 tag（轻量、附注都行）：

   ```sh
   git tag v0.4.0
   ```

3. 把提交和 tag 一起推上去：

   ```sh
   git push origin master:release --tags
   ```

4. 去 Actions 看那条 `Release` 运行，Summary 里写着结论：发了哪个版本、还是跳过了。

## CI 怎么判断该不该发

- **最近的 tag**：从 release 上这次推到的提交往回找，第一个打着 tag 的提交
  （`git describe --tags --abbrev=0`）。同一个提交上挂了多个 tag 时，优先用和
  `package.json` 版本对得上的那个；再对不上就直接报错，不猜。
- **已经进过 release**：这个 tag 是「这次推送之前的 release 提交」（`github.event.before`）的祖先，
  说明这个版本早就发过了 → `detect` 结束，发布任务不跑。
- **还没进 release**：不是祖先 → 检出那个 tag 提交，跑测试、`npm publish`、建 GitHub Release。

要是这次推上来的 HEAD 版本比最近的 tag 还新，`detect` 会给一条 warning：多半是新版本忘了打 tag，
或者推的时候没带 `--tags`。判定仍然按 tag 走 —— 没 tag 就没有版本可发；真忘了推 tag，
把 tag 补推上去，再往 release 推一次就会正常发。

拿推送前的提交比，而不是拿当前 release HEAD 比：release 一般从 master 快进过来，tag 天然是
HEAD 的祖先，用 HEAD 判断会让每次推送都被判成「已发过」，永远发不出去。

拿不到推送前的提交时（新建分支、强推后旧提交已经不可达）按「新版本」处理 —— 宁可多走一遍，
发布那一步有下面的幂等守卫兜着。

## 发布前跑的东西

- `npm test`：`tests/run.mjs` 第一组，纯 node，不依赖官方包。第二组要发行包 `app.asar` 里的
  `@deepseek-ai/*`，CI 上拿不到，所以不在流水线里（本地想跑见 [tests/README.md](../tests/README.md)）。
- `npm pack --dry-run`：看一眼发布包里到底有哪些文件，防止 `files` 漏了东西。
- 仓库没有运行时依赖、没有锁文件、没有构建步骤，所以流水线里没有 install / build。

## 幂等和重试

同一条流水线重跑不会重复发：

- npm 上已经有这个版本 → 跳过 publish；
- 同名的 GitHub Release 已经存在 → 跳过创建。

发布失败就在 Actions 里点「Re-run all jobs」。重跑用的是同一次推送的记录，`detect` 的判定不会变，
该发的还会发、该跳过的还会跳过，各步骤本身也幂等。

同一个分组（`release-publish`）里后来的推送会排队等前面跑完，不会被取消 —— 发布砍在半路最麻烦。

## npm 认证

走 Trusted Publishing（OIDC），仓库里不放长期 token：

1. 第一次发布先在本地 `npm login` + `npm publish`，把包在 npmjs.com 上建出来。
2. npmjs.com → 这个包 → Settings → Trusted publishing → 加 GitHub Actions：
   owner `XuezuoYS`、repository `dsh-prompt-inject`、workflow filename `publish.yml`，
   允许 npm publish。
3. 之后 CI 用 `id-token: write` 直接发，不需要 `NPM_TOKEN` 这个密钥。

哪天想退回 token 方式，就把 `Publish to npm` 那一步改成 `npm publish` 加
`NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`，再把 token 加进仓库密钥。

## 本地先验一遍

```sh
npm test             # 第一组验收脚本，CI 跑的就是它
npm run test:host    # 第二组，要先把发行包里的官方包解出来，见 tests/README.md
npm pack --dry-run   # 发布包的文件清单
```

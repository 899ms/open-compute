# CI 与 Rust 构建性能

2026-09-16。按 GitHub Actions 实际 run 记录复盘；以下数字是墙钟，不是 runner 分钟。

## 已观察到的成本

`main` 的旧轻量检查（`34015774164`）耗时 2 分 46 秒；加入生产 Clippy、no-default-features
和 production hygiene 后，健康缓存的 `34974064143` 耗时 8 分 04 秒，半成品缓存下的
`35006658887` 和 `35017803309` 分别耗时 18 分 37 秒和 19 分 39 秒。慢点不是 GitHub runner
本身：慢 run 的 `clippy` 为 519–539 秒、production hygiene 为 362–367 秒；健康缓存时分别为
131 秒和 81 秒。之前每个生产库单独调用 Cargo，还会在不同调用中重复依赖检查。

本轮把生产库 lint 合并为一次 `cargo clippy --workspace --lib --no-default-features --no-deps`，
所有生产目标禁止 lint 第三方依赖；`--no-deps` 仍需让 Rust 编译依赖作为类型检查输入，
只是不会对第三方源码运行 Clippy 规则；本机同一源码的 canonical Clippy 从冷依赖到通过为 28 秒。
Rust target cache 不再保存失败的半成品，package 的 sccache 改为每个平台/锁定输入一个稳定 key，
不再把 commit、run 和 attempt 写进 key。第一次 v2 key 会冷启动，之后相同平台和锁图可复用。

`33977849336` 已完成 coverage 和 Linux/macOS 最终 workspace Gate，但 Linux x64/arm64 的
package 在编译后执行无 `--config` 的 capabilities 命令失败。两个 package 步骤分别消耗约
18 分 33 秒和 17 分 28 秒，错误是 CLI 契约不一致，不是编译错误。此前 package 必须等待整条
资格验证完成才启动，导致这一简单错误直到最后才出现。

远端 cache inventory 显示只有历史 dependency caches，没有本次三个正式平台 release Rust cache。
原 composite action 虽然设置 `cache-on-failure: true`，却以 `save-if: main` 排除了 tag 运行。
旧失败任务没有上传原生二进制，结束后的托管 VM 不能再取回；不能宣称能复用没有保存的 build。

## 当前执行分工

- `main` 和普通 PR：同一 runner 完成 build/typecheck、快速工具测试、format、clippy、
  no-default-features、Rust 1.98 compile check、production hygiene、metadata 和边界检查。release tag
  校验精确 source commit 已通过该静态资格，不再重跑。
- tag qualification：coverage、一个 macOS 完整最终 workspace Gate 和 Linux `p0-2` 受控 egress
  在身份校验后并行启动；Linux egress 不再重复 `--workspace`。
- 三个正式平台 package：身份验证后即并行构建，和全部 qualification 重叠；publish 等待所有路径成功。macOS Intel 不再进入 package 矩阵。
- package 与普通 production hygiene 使用同一 executable verifier，生成 mode 0600 临时配置再查询
  capabilities，同时核对 release identity、版本、licenses 和嵌入 docs；不初始化平台数据目录。
- `main` 不保护；`release` 要求 PR、最新 required `ci` 和讨论解决；tag 必须来自通过 CI 的 `release`。

## 缓存与证据

- Rust dependency cache 按工具链、OS/CPU、编译环境和 manifest/lock 分隔；release target 与 coverage
  各自使用 profile key。失败的普通 target cache 不保存，避免把不完整目录当成下一次构建输入；PR
  仍不向共享 Rust cache 写入。
- Cargo registry/index/git 下载使用独立、仅由 OS 与 `Cargo.lock` 定位的缓存，避免 profile-specific
  target cache 未命中时重新下载全部 Rust 依赖。
- package 使用固定 sccache 0.16.0，512 MiB 本地缓存位于 `.temp/sccache`，整目录通过 Actions
  cache restore/save 复用；主 key 只包含 OS/CPU、Rust/sccache 版本和锁定输入，fallback 可跨源码
  commit 复用内容寻址的编译结果。精确命中不再重复保存，竞争保存失败也不影响构建。它是编译
  加速缓存，不是测试通过证据或可信发行物。
- 2026-09-16 inventory 有 22 个条目、约 9.57 GiB，已经贴近 GitHub 每仓库 10 GiB 上限；其中
  8 个旧 package compiler key 含 run/attempt，约 3.9 GiB，几乎没有跨发布复用价值。v2 key
  目标是三个平台各 512 MiB，稳定占用约 1.5 GiB；旧条目由 GitHub 的 LRU 淘汰，不手工删除失败证据。
- 不启用逐 crate 的 GHA sccache backend：并行矩阵会增加缓存 API 请求，已存在上游限流与延迟报告。
  最终链接、bin/proc-macro 编译等仍有不可缓存部分；不承诺完全免编译。
- 保存 Cargo `--timings` 报告、cache statistics、失败时的未验收原生 binary 和现有失败 Gate evidence。
  一般日志显示子命令 stderr，避免长时间只看到一个无输出步骤。
- source、formal runtime pin、生成资产和 artifact SHA 校验仍执行；不得通过伪造 mtime 或复用不同
  revision 的发布二进制制造命中。输入发生变化，已有 Gate 结果只证明它原来的输入。

## 研究取舍

| 候选                                   | 当前决定与依据                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 同一 runner / 合并重复步骤             | 普通 CI 使用一台 runner、一轮 build，避免重复安装与 fresh-checkout 编译                                             |
| package 与 qualification 并行          | 已配置；publish 保留所有依赖，提前暴露打包问题                                                                      |
| Cargo target cache                     | 保留按 profile/平台区分的依赖缓存；不盲目上传整个几十 GiB workspace target 导致缓存驱逐                             |
| sccache                                | 仅 native package 启用，限制容量并收集命中数据；coverage 保持现有插桩路径                                           |
| 容器 / cargo-chef                      | 当前三个正式平台原生 runner 不增加一套容器构建；Linux 容器不能证明 macOS 原生行为，镜像不能直接复用所有架构的机器码 |
| Fat LTO → ThinLTO / 更多 codegen units | 尚未改 release profile；先用 timings 定位实际链接成本，避免未测量的大小/性能变化                                    |
| nightly 编译参数 / 替换 linker         | 不引入 nightly 或未验证 linker；保持正式 Rust 1.98 和原生链接契约                                                   |
| 增大 Gate 并发                         | 保持审计后的 `--jobs 2` 和独占目标，不拿资源争抢换取新的时序失败                                                    |

## 测试与复用边界

- `main` 的静态资格只跑 build/typecheck、JS/Python tooling、fmt、Clippy、no-default-features、
  MSRV target check、production hygiene、metadata 和边界检查。tag 的 `validate` 只读取对应 main
  source commit 的成功 run；release 不重复 Clippy 或 MSRV。
- release 仍必须保留不同职责的 coverage、macOS 未插桩 workspace Gate、Linux `p0-2` 受控 egress、
  三平台单文件 package、SDK tarball 和最终 bytes/checksum 回读。coverage 与 Gate 使用不同编译
  插桩和宿主，不能拿一个替代另一个；package 的 native binary 也不能由 main 的 `cargo check` 代替。
- 固定输入变化的最小选择：只改 docs/notes 只做文档检查；只改 SDK 做 SDK typecheck/test/pack；
  只改 Rust 代码做受影响 crate/Gate，源码冻结前再做一次完整 workspace；修改 `workerd.lock.json`、
  `share/workerd/**`、runtime loader、Cap'n Proto 或 compatibility baseline 时，至少重跑
  `bun run build`、`p3-contract`、所有依赖真实 workerd 的 P0/P1/P2/Workflow/P3 targets、coverage
  和三平台 package。发布 tag 仍按 release workflow 的完整矩阵执行，不以窄选集冒充正式资格。
- Gate registry 统计当前 49 个 ONCE cases、55 个 TIMING cases；同一物理 target 的重叠选择只调度一次，
  `p2-3` 复用 `p0-2`，Linux egress 不再附带第二个 workspace round。确定性 case 不做重复轮次，
  取消、崩溃、重启和并发断言仍在所属 case 内执行。

## 失败后的选择性重跑

1. 源码或正式 pin 失败：修复后生成新的 release commit/tag；旧 run 的测试和 artifact 只证明旧输入，
   不复用到新 tag。
2. runner、网络或 GitHub 服务瞬时失败：在同一 tag 上只 rerun failed jobs，保留已成功 jobs/artifacts。
   `publish` 创建 Draft 已幂等，已有完整 Draft 可直接重跑 publish。
3. qualification 全部成功但 assemble/publish 失败：使用 `release-recovery` 的 `tag + source_run_id`，
   它重新验证 8 个成功 job，下载原 artifact，只重建 manifest、校验 Draft、npm 和公开 release，
   不重跑 coverage/Gate/package。
4. Draft asset 缺失、内容不一致或 source run 不完整：recovery fail closed；不得覆盖 asset，保留
   失败证据并生成新的候选或人工处理 Draft。

主要资料：

- [Cargo build cache](https://doc.rust-lang.org/cargo/reference/build-cache.html)：profile/target 布局与共享缓存。
- [Cargo timings](https://doc.rust-lang.org/cargo/reference/timings.html)：编译单元、并发与关键路径报告。
- [Cargo profiles](https://doc.rust-lang.org/cargo/reference/profiles.html)：LTO、codegen units 和 incremental 的权衡。
- [rust-cache inputs](https://github.com/Swatinem/rust-cache)：save-if、cache-on-failure 与 workspace crate 缓存行为。
- [GitHub cache scope](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)：分支/tag 可见性与不可覆盖条目。
- [GitHub artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts)：job 结束后的构建输出保留。
- [sccache Rust limitations](https://github.com/mozilla/sccache/blob/main/docs/Rust.md)：禁用 incremental、链接不可缓存与宏约束。
- [sccache cache API 请求问题](https://github.com/mozilla/sccache/issues/2730)：逐 crate 远端缓存的限流风险。

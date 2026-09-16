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

确定性发布错误也曾被发现得过晚：`34939860032` 与 `35001991046` 在 macOS workspace/coverage 跑到末尾后
才由 `p3-contract` 报 source digest drift；`35001991046` 与 `35008672807` 又在三平台 package 完成后才由
assemble 报 SDK package report schema 不匹配。`35020012666` 到 publish 才发现 npm 认证缺失；后续 run 的
`npm publish` 已成功，但紧接着的 registry read-back 因传播延迟返回 E404，继续轮询没有增加发布正确性。
现在 main CI 与 tag release 都先执行秒级 `failfast`：source identity、release-tool/SDK report contract、
release environment、npm 认证与目标版本状态任一失败，都不会启动 Rust coverage、Gate 或三平台 package。

`35025974065` 是最近一次 7 分 06 秒的 full main CI，但输入只修改 CI/release workflow 与其分类器。
其中 setup 78 秒、Clippy 89 秒、production hygiene 80 秒；后两项以及 no-default-features/MSRV 都没有
读取这次改动的生产 Rust。main 现在把 change classification 与 source/release-tool fail-fast 合并为一个
job，并为 release workflow、release assembler/test 与随附文档设置 `release-tooling` scope；该 scope 只跑
TypeScript、format、文档和 release contract 检查。修改 `ci.yml`、共享 setup action、Rust/runtime 或未知路径
仍跑 full checks，避免改了检查本身却从未执行它。
full scope 保留全部命令，但拆成三个并行 matrix leg：core 负责 JS/Python、format、no-default-features、
MSRV、metadata 与 boundaries，Clippy 和 production executable hygiene 各自独立。按 `35025974065` 的实测
step 时间，关键路径预计从 7 分 06 秒降到约 4 分钟；这是未 push 前的估算。full run 的总 runner 时间预计
从约 6.7 分钟增至约 11 分钟，因此不继续拆成更多 runner；路径分类负责让这种成本只发生在真正需要 full
资格的改动上。

`35026079295` 的单目标 dry-run 共 35 分 56 秒：正式 release profile 编译 26 分 25 秒，随后
`single-binary` Gate 的测试 harness 准备又耗时约 7 分 34 秒，而两个测试本身只有 7.25 秒。该 run 的
sccache 是 0 hits / 2,641 misses，保存又因 configured budget read-only 失败。dry-run 与正式 package
现在额外只读恢复可用的 main default Rust target cache，复用 debug/test 依赖；release profile 仍由独立
512 MiB sccache 加速，不把开发产物当发行物。单目标 dispatch 也只创建所选 runner，不再启动另外两个
立即 skip 的矩阵 job。7 分 34 秒是可优化上限，不是尚未实测的承诺；下一次 live dry-run 以实际 cache hit
和 Gate prepare 时间验收。

## 当前执行分工

- `main` 和普通 PR：`failfast` 同时完成变更分类与 source/release-tool contract；full scope 的 core、
  Clippy、production hygiene 三个职责并行执行，完整覆盖 build/typecheck、快速工具测试、format、
  no-default-features、Rust 1.98 compile check、metadata 和边界检查；这些任务统一依赖
  秒级 `failfast`。release-only tooling scope 不启动 Rust。release tag 校验精确 source commit 已通过该静态资格，不再重跑。
- CI 先按变更路径分类：纯 `docs/**`、README 和 release notes 只执行文档检查；纯 SDK、dashboard、
  website 或 toolchain 变更只执行对应 JavaScript 检查；release workflow/assembler/test 使用独立
  release-tooling 检查；Rust、runtime、workerd、`ci.yml`、共享 setup、未知路径或混合变更仍执行完整静态资格。
  汇总 job `ci` 保留不变，避免分支保护因跳过具体 job 失效。
- tag qualification：`failfast` 先验证 release environment、source/release identity、notes、SDK report
  contract、npm credential 和目标版本；随后 coverage、一个 macOS 完整最终 workspace Gate 和 Linux
  `p0-2` 受控 egress 并行启动；Linux egress 不再重复 `--workspace`。
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
- 之后的 dry-run `35026079295` 首次 Linux x64 打包成功（35 分 56 秒，其中 package 34 分 42 秒），
  但 sccache 是冷缓存（0 hits、2,641 misses）。保存 512 MiB cache 时 GitHub 返回 configured budget
  read-only；Actions API 当时仍列出 23 个条目、11,866,896,013 bytes，且 storage-limit API 为 20 GB，
  所以这次没有产生可复用的 v2 compiler key。保存步骤是非阻断的，不能把这次成功误报为 warm-cache
  效果；待配额实际可写后再用下一次 package run 测量命中率。
- 2026-09-16 再查 API：repository storage limit 已显示 20 GB，但 23 个 cache 共 11,866,896,013 bytes，
  仍没有任何 `compiler-v2-*` key；因此不能把配额页面变化当作 cache 已可写的证据。GitHub 的仓库 cache
  limit 与 `Actions Cache Storage`（`actions_cache_storage`）预算是两个独立开关：预算为零或已触顶时，超过
  免费 10 GB 后 cache 会保持 read-only。20 GB 上限全部用满时只有额外 10 GB 计费，按当前 $0.07/GB-month
  最多约 $0.70/月；账户预算应至少设为 $1/月，或先删到 10 GB 以下。repo workflow 的 `cache-mode` 不能绕过
  这个 billing 限制。
- 不启用逐 crate 的 GHA sccache backend：并行矩阵会增加缓存 API 请求，已存在上游限流与延迟报告。
  最终链接、bin/proc-macro 编译等仍有不可缓存部分；不承诺完全免编译。
- 保存 Cargo `--timings` 报告、cache statistics、失败时的未验收原生 binary 和现有失败 Gate evidence。
  一般日志显示子命令 stderr，避免长时间只看到一个无输出步骤。
- source、formal runtime pin、生成资产和 artifact SHA 校验仍执行；不得通过伪造 mtime 或复用不同
  revision 的发布二进制制造命中。输入发生变化，已有 Gate 结果只证明它原来的输入。

## 研究取舍

| 候选                                   | 当前决定与依据                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| full CI 并行职责                       | 三个 runner 把 89 秒 Clippy 与 80 秒 production link/scan 移出 core 关键路径；不再细拆，控制总 runner 成本          |
| package 与 qualification 并行          | 已配置；publish 保留所有依赖，提前暴露打包问题                                                                      |
| Cargo target cache                     | 保留按 profile/平台区分的依赖缓存；不盲目上传整个几十 GiB workspace target 导致缓存驱逐                             |
| sccache                                | 仅 native package 启用，限制容量并收集命中数据；coverage 保持现有插桩路径                                           |
| 容器 / cargo-chef                      | 当前三个正式平台原生 runner 不增加一套容器构建；Linux 容器不能证明 macOS 原生行为，镜像不能直接复用所有架构的机器码 |
| Fat LTO → ThinLTO / 更多 codegen units | 尚未改 release profile；先用 timings 定位实际链接成本，避免未测量的大小/性能变化                                    |
| nightly 编译参数 / 替换 linker         | 不引入 nightly 或未验证 linker；保持正式 Rust 1.98 和原生链接契约                                                   |
| 增大 Gate 并发                         | 保持审计后的 `--jobs 2` 和独占目标，不拿资源争抢换取新的时序失败                                                    |

## 测试与复用边界

- `main` 的静态资格先跑 source/release-tool `failfast`，再按变更范围执行 build/typecheck、JS/Python
  tooling、fmt、Clippy、no-default-features、MSRV target check、production hygiene、metadata 和边界检查。
  tag 的 `failfast` 读取对应 main source commit 的成功 run，并额外验证 release-only environment/notes/npm
  contracts；release 不重复 Clippy 或 MSRV。
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

## Dry-run release

`release-dry-run.yml` 用指定 ref 构建并验证 SDK、单个平台原生包和 `single-binary` Gate，不创建
GitHub Release、不发布 npm，也不修改 tag。默认只跑 Linux x64 以快速检查；需要验证三平台组装时显式
选择 `target=all`：

```sh
gh workflow run release-dry-run.yml --ref main -f ref=main -f target=linux-x64
gh workflow run release-dry-run.yml --ref main -f ref=main -f target=all
```

它是发布前的构建/组装烟测，不替代正式 tag 的 coverage、完整 workspace Gate、受控 egress 或公开发布
回读；失败时保留 artifact 和编译缓存统计，便于定位而不触发真实发布副作用。

主要资料：

- [Cargo build cache](https://doc.rust-lang.org/cargo/reference/build-cache.html)：profile/target 布局与共享缓存。
- [Cargo timings](https://doc.rust-lang.org/cargo/reference/timings.html)：编译单元、并发与关键路径报告。
- [Cargo profiles](https://doc.rust-lang.org/cargo/reference/profiles.html)：LTO、codegen units 和 incremental 的权衡。
- [rust-cache inputs](https://github.com/Swatinem/rust-cache)：save-if、cache-on-failure 与 workspace crate 缓存行为。
- [GitHub cache scope](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)：分支/tag 可见性与不可覆盖条目。
- [GitHub artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts)：job 结束后的构建输出保留。
- [sccache Rust limitations](https://github.com/mozilla/sccache/blob/main/docs/Rust.md)：禁用 incremental、链接不可缓存与宏约束。
- [sccache cache API 请求问题](https://github.com/mozilla/sccache/issues/2730)：逐 crate 远端缓存的限流风险。

# I87、I103–115：issue 实施方案

状态：**planned**。本文只记录实施方案；尚未修改生产代码、依赖、submodule 或生成文件。

当前开放 issue 共 11 个，本文逐项覆盖 `#87`、`#103`–`#106`、`#110`–`#115`。

| Issue                                                                            | 核实结论                                                                                                               | 方案位置          |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------- |
| [#87](https://github.com/elliothux/open-compute/issues/87) Git thin-pack         | 属实：当前 Gitserver pin 缺少既有对象 delta-base resolver                                                              | 下文“#87”         |
| [#103](https://github.com/elliothux/open-compute/issues/103) upstream refresh    | 属实：Wrangler pin 变化需要同步配置、CLI 和产品证据                                                                    | 下文“#103”        |
| [#104](https://github.com/elliothux/open-compute/issues/104) upgrade latest      | 属实：匿名 GitHub REST 配额耗尽导致默认升级失败                                                                        | 下文“#104”        |
| [#105](https://github.com/elliothux/open-compute/issues/105) upgrade 恢复        | 属实：目标 binary 在数据兼容性检查前替换，失败会留下不可用实例                                                         | 下文“#105”        |
| [#106](https://github.com/elliothux/open-compute/issues/106) Service props 类型  | 属实：上传端接受 `props`，公开 SDK 类型没有                                                                            | 下文“#106 / #112” |
| [#110](https://github.com/elliothux/open-compute/issues/110) AI Search binding   | 属实：公开 instance key 与内部 Resource name 不同                                                                      | 下文“#110”        |
| [#111](https://github.com/elliothux/open-compute/issues/111) Workflow stale      | 属实：上传预留 definition，但未 stage/publish Workflow version                                                         | 下文“#111”        |
| [#112](https://github.com/elliothux/open-compute/issues/112) SDK multipart       | 属实：SDK 展平 metadata，服务端要求单个 JSON part                                                                      | 下文“#106 / #112” |
| [#113](https://github.com/elliothux/open-compute/issues/113) Artifacts lifecycle | 部分属实：官方 runtime 类型和服务端 binding 已有，标准项目工具链与管理 SDK 上传类型未闭环；namespace delete 非官方合同 | 下文“#113”        |
| [#114](https://github.com/elliothux/open-compute/issues/114) 私有 Service        | 属实：当前 public-only 通用出网按设计拒绝私网；缺少 operator-owned 的限定能力                                          | 下文“#114”        |
| [#115](https://github.com/elliothux/open-compute/issues/115) Queue messages      | 属实：Worker binding 支持 send/sendBatch，管理面没有公开 message 操作                                                  | 下文“#115”        |

## #87 Gitserver fork 与源码构建

1. 将 `https://github.com/elliothux/gitserver` 加为 `third_party/gitserver` submodule，模式与
   `third_party/workerd` 一致；gitlink 固定含 receive-pack thin-pack 修复的提交，不在 `.gitmodules` 跟踪可变分支。
2. workspace 的 `gitserver-core` 从远端 Git revision 改为
   `third_party/gitserver/crates/gitserver-core` path dependency；根 workspace 排除嵌套 gitserver workspace，确保 Cargo
   直接从固定 submodule 源码编译。
3. 不改变 Artifacts authority、鉴权、Git smart-HTTP 路由或客户端行为，不保留旧远端依赖 fallback。
4. 回归覆盖首次 push、修改既有 blob 后产生 remote-only delta base 的后续 thin-pack push、clone/fetch、未授权写入、失败不更新
   ref，以及 daemon restart 后读取。

## #103 Cloudflare OpenAPI 与 Wrangler

重新执行 upstream scanner，逐项审查 selected operation 的 schema diff。更新 OpenAPI lock/subset、Wrangler catalog/Bun lock、
Wrangler config schema 与 CLI fixtures、生成的 SDK/surface 和兼容性文档；对变化的请求、响应和配置跑受影响的真实产品 Gate。
`#103` 原 issue 的 `blocked` 是协调验收条件，不能通过仅替换版本字符串解除。

2026-09-23 的只读 upstream scan 得到候选 OpenAPI revision
`a1af27335c3e43b3f9ba7cb326df27c060f61afe`、Wrangler `4.136.3`；正式实施时必须重新扫描并冻结当时最新 identity，不能把本文中的候选值当作自动升级来源。

## #104 默认升级解析

从 release-hosted `releases/latest/download/release.json` 读取最新版 manifest，校验 stable tag/version，再用该 tag 的
`SHA256SUMS` 校验 manifest 与目标 binary。显式版本继续使用 immutable tag assets；`--dry-run` 走相同 metadata 校验。
HTTP 404、限流和网络错误输出可区分、无 secret 的诊断。验收覆盖最新链接重定向、坏 manifest、tag 不匹配、checksum 失败及显式版本。

## #106 / #112 SDK 上传

在 SDK generator 中扩充 Script 与 Version 上传参数：Service binding 的 `props` 限定为 JSON object；文件上传由
公开 facade 发送单个 JSON `metadata` part 和各模块文件 part，保留官方 transport 的认证、超时、重试与错误类型。
同一序列化路径验证多步 Durable Object migration、Service props、Worker Loader、无文件与有文件请求；更新生成文件和类型夹具，
不手改 `dist/`。

## #110 AI Search binding

上传 metadata 接受官方可选 `namespace`，省略时用 `default`。在账户边界用 AI Search catalog 的 namespace + public
instance key 解析实际 Resource ID，并检查 namespace/instance 均 ready 且 healthy；不再比较内部 Resource name。
通过真实 v4 create namespace/instance → Worker upload → runtime binding 测试，另测跨 namespace、缺失与 unavailable；普通 Worker
及 Dynamic Loader 路径都要覆盖。

## #111 Workflow version 发布

在共用 Version pipeline 中把上传取得的 Workflow reservation 与 Worker version 绑定，Worker validation 成功后完成 Workflow
stage、class probe、finish/publish，之后才允许该 Worker 作为 ready deployment 使用。失败释放或拒绝对应 reservation，重复请求与
crash recovery 按既有 fencing 语义恢复；不能只在 HTTP handler 返回前补一次 publish，因为 ready/active Worker 会短暂引用 stale binding。
验收包含普通 Worker、Dynamic Loader、probe 失败、重试与重启。

## #115 Queue management messages

按官方 Queue v4 `messages.push` / `messages.bulkPush` 路径和 SDK 类型增加账户授权的 send/sendBatch，复用 durable enqueue、公开
Queue identity、既有大小/批次限制和幂等 request identity，记录超时后的 result-unknown 语义。`pull`、`ack`、`peek`、`purge`
留在未支持范围：当前产品没有 `http_pull` consumer 的 lease、ack/retry 和 crash recovery 合同。验收包含单条/批量、超限、
未授权、重放、enqueue 后重启；不能暴露内部 binding ID 或 runtime token。

## Cloudflare 兼容边界

- Worker upload、AI Search binding、Workflow binding 和 Queue producer 行为保持官方字段、错误边界与 runtime 类型；本批不新增
  vendor runtime API。管理 SDK 对官方 package 尚未声明但 open-compute 已支持的字段，只在生成的 open-compute 参数类型中做
  精确 JSON/wire 扩展，不改写 Cloudflare runtime declarations。
- Queue management messages 使用 Cloudflare 当前公开路径和 `cloudflare` SDK 的 `BaseMessages` 类型；只公布本地实现并完成资格的
  push 操作。Queue pull HTTP endpoint 属于独立 external data-plane protocol，不因 Worker Queue runtime 已兼容而自动进入支持面。
- 单机 SQLite authority、at-least-once Queue/Workflow recovery 与 hosted placement/replication 差异继续由
  `OC-QUEUE-001`、`OC-WORKFLOW-001`、`OC-AI-SEARCH-001` 描述；本批不得新增缺方法式 deviation。

## #105 的平衡方案与 migration 规则

`0.1.10 -> 0.2.0` 的事故不是修改了已执行 migration。0.2.0 追加的 control V7 在发现旧 schema 1
`version_services` 数据时按设计原子拒绝；已发布 V1–V6 的文件和 checksum 没有变化。当前仓库规则保持：**任何已进入正式 release、
可能已在用户设备执行的 platform migration 永远不可修改、删除、重命名、重排或重编号；后续 schema 变化只能追加 migration。**
只有从未进入正式 release 的当前开发 migration 可以在发布前直接整理。Day1 原则不覆盖这条数据完整性规则。

#105 不采用持久 upgrade saga 或逐 durable boundary 自动恢复。单机 SMB 的平衡方案是：

1. staged target binary 先以只读命令检查每个 active instance 的 config、data layout 和 migration 可执行性；`--dry-run` 运行同一检查；
2. 替换前保留旧 binary 与 receipt，正常返回前不删除；
3. 同步 restart/readiness 失败时恢复旧 binary/receipt，并 best-effort 恢复原 active set，逐实例报告主错误和恢复错误；
4. 不承诺进程被 SIGKILL 或机器断电后的自动事务回滚。binary/receipt digest 不一致或遗留 backup 时下次命令 fail closed，给出明确的 inspect/restore 命令，由 operator 选择保留新版本还是恢复旧版本；
5. stopped instance 保持 stopped，`--no-restart` 保持显式非平滑语义。

这覆盖已复现的 migration/preflight 和正常命令失败路径，不为低概率中断引入 journal 状态机。只有实际出现无法靠 fail-closed
诊断和保留 backup 恢复的中断事故时，再增加 durable journal。

## #113 Artifacts 结论

Artifacts runtime facade、server upload binding、固定 Wrangler 的标准 `artifacts` 配置、namespace/repository/token API 和 Git Smart
HTTP 已实现；单机存储拓扑差异由 `OC-ARTIFACTS-001` 约束。当前 framework toolchain 却仍拒绝 Wrangler 的 `artifacts` key，属于本地
集成缺口，不能据此宣称所有项目工作流均闭环。

实施时让 framework toolchain 接受并验证标准 Wrangler `artifacts` 配置，沿用已有 server upload binding 与 namespace authority，
再用标准项目配置走完 build → upload → runtime binding。此项属于 #113 的实际修复范围。

固定 `@cloudflare/workers-types@5.20260830.1` 已有官方 `Artifacts` / `ArtifactsRepo` 运行时类型，`wrangler types` 可生成
`Env { ARTIFACTS: Artifacts }`；不复制或改写这些类型。固定 `cloudflare@7.1.0` 的 Script/Version Worker upload binding union
尚未声明 Artifacts，虽然 Wrangler 已使用 `{ type: "artifacts", name, namespace }` wire。因此在现有 SDK generator 中增加
`OpenComputeArtifactsBinding`，仅作为 open-compute 的管理端上传参数扩展，同时覆盖 Script 与 Version 上传；字段严格对齐
Wrangler wire 和服务端校验，不冒充官方 SDK 类型。待官方 SDK 收录后删除本地扩展并直接复用。验收需覆盖两种上传、标准
Wrangler 配置和真实 runtime binding；该扩展本身不是运行时全量兼容证明。

Cloudflare 当前也没有 namespace delete API；namespace 是稳定 account container，repository/token 才是可删除资源。本项目不增加
非官方 namespace delete，也不为它扩展 migration/state machine；文档需明确 namespace permanence。

## #114 Operator-owned 私有 Service target

现象属实，public-only `fetch()` 拒绝 loopback/private 地址是现有安全边界，不能给 utility Worker 放开通用私网访问。
现有普通 Worker Service Binding 和 `props` 已可把调用送到 named Worker；本地 extension 走独立 host broker，但目前需要
产品提供 native executable，不能直接代表这个 issue 所需的通用 HTTP target。

方案是在 operator 配置中声明一个具名、固定的私有 HTTP Service target，记录精确 scheme、IP/host、port、允许的路径与方法、
credential 的 env/file 引用，以及获准绑定的 account + Worker/version + entrypoint。部署时从受信配置解析 target，并在
Service binding 的 immutable descriptor 中固定 target 身份与策略 revision；租户 upload metadata 只能引用已获准的服务名，
不能指定私网 URL、credential 或自行扩权。运行时复用 Service Binding 的 Request/Response 调用通道，由 `ocd` 代发至固定
endpoint，在 host 侧注入 credential；禁止重定向到其他地址、DNS 重绑定、向 Worker 转发认证信息，以及错误/日志中的敏感值。
控制配置变化或旧版本失去授权时 fail closed，重启后从配置和持久 descriptor 重新校验。

验收使用真实 workerd 与本机私有 HTTP fixture：获准 utility Worker 经普通 Service Binding 完成请求/响应流，未获准 Worker、
版本或 entrypoint 无法绑定或调用；普通 `fetch()` 仍拒绝私网；credential 不进入 tenant env、请求可见头、日志或错误；
验证重定向、地址变化、取消/超时、target 停止和 daemon restart。若现有 Service transport 不能保持所要求的流与取消语义，
先记录具体差异并阻止宣称 #114 完成。

## 验收

- SDK：generator byte-drift、Script/Version JSON metadata multipart、Service props、Artifacts 上传类型与 wire、DO 多步 migration、官方 Queue Messages 类型与请求 trace。
- Rust focused：AI Search namespace lookup、Workflow successful promotion/failure release/retry、Queue push/batch limits/idempotency/error mapping、
  release latest redirect/manifest/tag/checksum。
- Product：真实 pinned workerd 下 v4 create AI Search/Workflow/Queue -> upload/deploy -> runtime call，普通与 Dynamic Loader 共用路径。
- Upstream：scanner frozen identities、OpenAPI selected-operation closure、Wrangler schema/CLI evidence、generated artifacts 和受影响 product Gate。
- 最终按仓库规则执行静态检查、coverage 和一次 workspace Gate；未经成功执行不得把本文移动到 `docs/implemented/`。

## Cloudflare compatibility check 结论

按 `cf-compatibility-check` 的 runtime/type/persistence/产品 Gate 清单，#110、#111 需要追踪正式 runtime binding、持久 authority、
普通 Worker、Dynamic Loader 与真实 pinned workerd。#114 是 operator 配置的额外 Service target，必须维持同一官方 Service Binding
调用形态和 public-only 通用出网；不得让租户自报私网目标。#115 是管理面路径，不能用 runtime 兼容性检查代替 v4 wire 验收。
#113 的官方 runtime `Artifacts` 类型保持原样；本地 `OpenComputeArtifactsBinding` 只补管理端上传类型，不得冒充
官方 SDK 类型或作为 runtime 兼容证据。本文是设计检查；生产实现完成并取得对应 Gate 证据前，不宣称已通过
Cloudflare 兼容性验收。

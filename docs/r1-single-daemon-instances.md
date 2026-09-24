# R1：单 OCD daemon、多 Instance 与单一身份重构

状态：**本地实现与最终 Gate 完成；外部环境资格仍待验证**。2026-09-24。审阅基线：`d66e41e8b996cce8471c795fdefaa3ce8fe9e149`。

本地最终验收：`bun run build`、Rust format/Clippy、no-default-features、Rust 1.98 MSRV、metadata、依赖边界和 `git diff --check` 通过。正式 pinned workerd 下，instrumented workspace Gate 为 53/53 targets、1677/1677 cases，通过后 Rust line coverage 为 143984/159950（90.02%）；源码冻结后的未插桩 workspace Gate 单轮同样为 53/53、1677/1677，通过。证据分别见 [coverage summary](../target/llvm-cov/summary.json)、[instrumented Gate report](../.temp/gate-run/20260924T223403-deb8b3e0/report.json) 和 [final Gate report](../.temp/gate-run/20260924T232214-ccd9dcbc/report.json)。macOS system launchd 实机 sudo 验收已验证非 root 运行、权限、控制 socket、停止与可回收清理；证据位于 `.temp/r1-system-service/`。Linux systemd、不同 UID 的 Linux peer、GUI/TCC、低端口和公网 DNS/ACME 签发/恢复尚无实环境资格，不能标为通过。本文件下方的“Gate 待运行”等段落是实施中记录，以本段最终本地验收结果为准；未完成的外部资格限制仍有效。

CF 兼容性复核限定于 R1 改动的租户运行时：公开 Worker binding/API 类型未新增账户别名；Loader、DO、Queue、Cache、Images、AI 与 observability 的实例身份只经私有 authority/header 传递，正式 pin 的真实进程及 P3/P6 产品 Gate 通过。对照 [当前兼容矩阵](references/cloudflare-compatibility.md)、[官方 Worker bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/) 和 [官方 DO namespace](https://developers.cloudflare.com/durable-objects/api/namespace/)，未发现 R1 引入的公开 API 不匹配。`/client/v4` 的 `account_id` 是独立的管理 wire，不当作租户 runtime 成员；本轮未创建 Cloudflare 托管资源，新的 hosted differential 仍未验证。

Workflow 定义与冻结目标、Queue claim/在途变更、Cron projection/run、Cache key 与 operator 检查视图、Worker 版本/部署管线的私有身份字段现直接使用 `instance_id`／`instanceId`；D1 transfer 输入和 D1 文件元数据也统一命名。Workflow 控制器的所属实例参数不再称为 account；非 CF 适配层的 D1、KV 备份、R2、AI Search、Dashboard 与 Worker pipeline 私有身份参数也已改名。Workflow 目标与 Cache key 反序列化拒绝旧 `accountId`，Cache 数据库与 D1 文件元数据只接受新 `instance_id`，旧 D1 键拒绝且原数据不被改写。局部 Workflow 存储 23 项、Workflow 调度 26 项、Queue/Cron 投影 25 项、Cache 14 项、D1 history 6 项、Worker pipeline 7 项以及 D1 元数据拒绝/备份恢复定向测试通过；相关新命名也通过全目标编译和定向回归。非 CF 生产模块的私有身份命名现已统一；完整 R1 Gate 仍待验收。

本文定义目标合同、实施原则与验收要求。当前已完成显式 `config → [data].path`、`ocd.toml` 最小清单及共享 listener/admin 凭证配置读取、实例 deployer/read-only 凭证分离、可选名称选择、实例元数据直接持久化唯一 InstanceId、OCD_DIR 数据目录包含检查、本地 objects 从 `[data].path/objects` 派生且拒绝 `storage.path`，以及启动期间持有的作用域 `ocd.lock`。一个 daemon 已能从同一清单 autostart 两个独立 InstanceRuntime、共用 HTTP listener，并由 Host 和凭证隔离路由；`ocd run` 已按 user/显式 system 作用域读取清单，不再依赖 `--config`。Cloudflare 线协议的 `account_id` 现直接使用 InstanceId；全局 admin 在 loopback 管理 Host 的 `/accounts`、`/memberships` 可发现全部已登记实例，实例 token 的 `/accounts` 只返回自身。局部实进程测试验证两个不同 workerd PID、跨实例凭证拒绝、停止 A 不影响 B、全局 admin HTTP list/start/stop，以及 CLI `ocd instance setup|start|stop|restart|add|remove`：setup 可创建外置显式数据根并选择不 autostart/不立即启动，add 只登记已有显式配置，remove 保留配置与数据，清单被外部修改后在线写入拒绝覆盖；`instances/` 中未登记配置未被扫描。控制 socket 位于 `OCD_DIR/run/` 并读取真实 peer UID。共享 Gateway 已接入生产启动路径并有局部实进程测试；共享 OS service 的 unit/plist 渲染及升级/卸载作用域语义也有局部测试。控制库新增 V9，将已发布迁移中的单行 `accounts` 表原子收敛成唯一 `instance_identity`，不一致的旧权威拒绝迁移；存储侧查询已转向新表，非 CF 生产模块不再保留账户别名。macOS 实机 system launchd 已完成一次隔离端口的提权安装、非 root 运行和权限验收；Linux systemd、temp/备份边界等仍未闭环。这些局部测试不构成 R1 完整验收。按 Day1 直接替换当前模型，不维护旧 open-compute 的布局、配置或身份兼容路径。

所有平台自有 SQLite 库现只接受空库或可核验的正式 Refinery 迁移历史；没有历史的非空旧库不再通过基线收养/改写。控制、scheduler、KV、D1、Vectorize、AI Search 与 observability 共用这条拒绝规则，已发布迁移文件本身未改动。资源库 schema 巡检在可能执行迁移前先核验文件内的 InstanceId／ResourceId（Vectorize、AI Search 核验 ResourceId），错属文件拒绝且保持原内容；相关存储定向测试通过。

V9 现先核验旧审计、幂等、R2、Cron、两条上传链及 Queue/consumer/resource/Artifact namespace/Worker/hostname claim/route/Workflow definition 行的身份，再移除 `control_audit_events.account_id`、`control_idempotency.account_id`、`worker_delete_intents.account_id`、`system_owned_versions.account_id`、`r2_objects.account_id`、`r2_object_mutations.account_id`、`r2_multipart_uploads.account_id`、`cron_activations.account_id`、`asset_upload_sessions.account_id`、`version_uploads.account_id`、`queues.account_id`、`queue_consumers.account_id`、`resources.account_id`、`artifact_namespaces.account_id`、`hostname_claims.account_id`、`worker_host_routes.account_id`、`workflow_definitions.account_id` 和 `workers.account_id` 恒定列；这些 authority 直接使用实例本地作用域。仓储入口仍核验调用者 InstanceId，Queue 与资源绑定的 SQLite 插入触发器仍校验 Worker 归属与单实例身份。局部迁移测试覆盖旧行保留、不匹配回滚、上传对象等子表引用、删除意图、系统 pin、R2 对象/在途变更、multipart 上传、Cron activation、Queue/consumer、资源及 Artifact namespace/repository/token/binding/hostname claim/route/Workflow definition/Worker 关联保留；资源、KV/D1/R2/DO/AI Search 与 Artifacts 定向目录测试及双实例独立数据根的资源/版本隔离测试已通过。当前 schema 的私有身份已收敛；完整迁移链仍待最终 Gate 验证。

Queue 创建请求、scheduler Queue 投影、资源创建/预留请求、D1 transfer/session/backup 协调器、Worker HTTP v4 解析后的私有局部值及 storage 生产 Rust 代码中的身份参数现为 `instance_id`；Queue 仓储的私有枚举入口也改为 `list_instance`。CF 路由边界仍按官方 `account_id` 参数接收原值后传入。storage/workers/service 全目标编译，以及 D1 transfer 重启、Queue/Worker 仓储和 Assets 上传定向回归通过；非 CF 生产模块的私有身份命名现已统一。

私有 secret/R2 SSE-C envelope 与 D1 bookmark 已切换新版本和 InstanceId AAD；旧版本明确拒绝、不删除原密文，定向测试覆盖拒绝。Worker secret 入库前现在拒绝非当前 envelope 版本，快照读取按同一当前版本重建；局部真实版本创建、部署和运行时快照解密测试通过。KV namespace SQLite 的私有身份元数据也改为 `instance_id`，旧 `account_id` 键被拒绝且不改写原文件；7 项 KV engine 定向测试通过。完整重启/备份恢复验收仍未完成。

独立 scheduler 库的未发布 V3 迁移从 Queue、Cron、Workflow 投影核对并提取唯一 InstanceId，混合所有权使迁移原子回滚，然后删除三个业务表的恒定 `account_id` 列。生产启动、快照恢复和显式损坏库恢复传入控制库/已验证 manifest 的身份；scheduler 在任何过期任务恢复前拒绝库级身份错配或有任务却缺失身份。Queue、Cron 和 Workflow 的投影写入核验所属实例，读取从库级身份取得所属实例；doctor 也核验控制库与 scheduler 库的一致性。局部 53 项 scheduler 测试及 storage/workers/service 全目标编译已通过；非 CF 生产模块的私有身份命名现已统一，完整 R1 Gate 仍待验收。

独立 observability 库现新增 V2 迁移：先从 invocation/event 投影核验唯一 InstanceId，拒绝混合身份并原子回滚，再删除两表逐行重复的 `account_id`；当前库只保存一行 `observability_identity`。生产启动将该库绑定到 control 库的 InstanceId，错配或库不可用使该实例启动失败，不再静默禁用持久日志。写入与查询均核验实例身份，私有游标、Tail session 与 collector 也只使用 `instanceId`。10 项存储定向测试覆盖新建、重启、旧 V1 行保留、混合所有权回滚、外键损坏及跨实例拒绝；服务全目标编译、6 项 observability 服务定向测试和单二进制重启/身份错配定向测试通过。完整 R1 Gate 仍未运行。

`ocd status` 现报告所选作用域 daemon 的运行状态，`ocd instances` 读取其实时实例状态；仅在作用域锁可取得的离线状态下，才按清单显示 stopped。首次 `ocd setup` 的配置/凭证发布现也持有同一作用域锁，服务启动前释放；system setup 将锁归属于运行 daemon 的非 root 用户。system setup 不再对数据目录执行递归 `chown`：新建数据根在 bootstrap 期间保持调用者私有，之后先核验全树仅有初始化预期的普通文件/目录、owner 和 0700/0600 模式，再通过 no-follow 文件描述符逐项移交，最后移交根；未知文件、符号链接或不安全的既有空目录拒绝且保留原内容。顶层 setup 还在任何写入前强制生成的实例 secret 目录恰为显式 `[data].path/keys`，不接纳第三个输出根。局部 setup 测试、越界 secret 根定向测试与 SUDO 身份子进程测试通过。macOS 实机验收发现 `/var` 规范化为 `/private/var` 后，system setup 漏掉 `instances/` 及其子目录所有权移交；修复为按规范根处理路径后，使用管理员认证与经 `id` 核验的原用户 SUDO 身份变量重新安装，launchd 以 UID 501 非 root 启动，`ocd status` 和 `instances` 均报告运行。OCD 根、实例目录、socket 和密钥为预期的 `0700/0600`；root 与运行 UID 可连接控制 socket，其他 UID 返回 `EACCES`；重复启动拒绝且原 socket inode 不变，变更 HOME 不创建另一 system 根。产品停止命令完成后 PID、控制 socket 与 workerd lease 消失；plist 和 OCD_DIR 仅移至 `.temp/r1-system-service/` 保留验收证据，系统位置恢复为空。原生 `sudo` 命令入口及 Linux systemd 的实机验收仍未运行。

仓库开发脚本及 systemd/launchd/container 示例已移除旧的单实例 `[server]`/`storage.path` 配置文件和 `--config run` 调用；部署示例使用显式 system 作用域的共享 daemon、非 root 用户及其 OCD_DIR。`dev-test.sh` 使用 `test-support` 隔离 OCD 根，先启动共享 daemon 再通过 `instance setup` 写入显式 `[data].path`。单实例开发 smoke 已在独立端口与作用域通过，不替代上文双实例实进程测试或最终 Gate。

升级检查缓存现位于所选 `<OCD_DIR>/cache/update-check.json`，后台检查继承 user/system 作用域；CLI target 清单现位于所选 `<OCD_DIR>/targets.toml`，缺失 OCD 根时不会由 target 增删命令擅自创建。未显式选择配置或实例的 CLI 不再从 cwd、HOME/XDG 或 `/etc/open-compute` 发现旧配置，只在清单中恰有一个实例时选择它。安装 receipt 已归入所选 OCD_DIR；其他工具输出根仍待核对。

离线 CLI 的共同配置解析现在也用所选 OCD 根校验显式 `[data].path`；局部测试证明 restore 的 `--config` 不能把数据写入 `<OCD_DIR>/cache/`，而 `<OCD_DIR>/instances/dev/data/` 仍合法。restore 持有离线 OCD 作用域锁；全局备份恢复后若锁文件不存在，可仅在已恢复、owner/mode 正确的 OCD_DIR 内创建新锁，而不会新建 OCD_DIR。目标只从显式清单中的配置校验，不得与其他已登记实例数据根重叠；即使待恢复实例的 control 数据库已丢失也可校验。恢复前还从其他已登记且存在的 control 数据库读取 InstanceId，快照身份若重复则拒绝且不创建目标；局部 S3 快照与清单测试覆盖此路径，其他尚未恢复的实例身份仍须在整机冷恢复完成后统一核对。Local 对象根已固定在实例数据目录内，不能同时作为空目标之外的快照来源；Local 全新主机恢复必须使用 operator 备份的完整实例数据目录，`backup restore` 明确仅支持 S3 快照，定向测试确认 Local 路径拒绝且无写入。备份/恢复身份和外置状态的完整验收仍待完成。

远端 open-compute target 现在直接登记 InstanceId，不再保存独立的 `CloudflareAccountId` 类型或 `account_id` 私有字段；CLI 使用 `--instance-id`，仅 CF 请求路径和 Wrangler 环境变量沿用协议名称。Dashboard 私有会话、状态和展示也已改用 `instanceId`，仅调用官方 SDK 时写入 `account_id` 参数；前端类型检查及 6 项单元测试通过。局部 target/launcher 单元测试已通过；全量 SDK/Wrangler 验收仍待最终 Gate。

运行时 observability collector 和 loader 快照校验的私有身份字段现为 `instanceId`，只接受 32 位规范 InstanceId，不再因旧 36 位账户 UUID 校验而静默丢弃日志或拒绝启用日志的 Worker。DO host、Queue/Cache/Images/AI 私有 transport 已统一使用 `instanceId`/`x-open-compute-instance-id`，DO host 拒绝旧 36 位账户 UUID；局部 TypeScript 采集、快照、DO host 和 Rust ingest 测试已通过。其他内部 account 命名仍待收敛。

实例内 AI Search source provider 配置已删除多实例 `account_ids` 白名单；provider 随所属实例配置加载，只能由该实例自己的资源调用，旧字段严格拒绝。定向配置与 backend 测试已通过。Runtime loader key 的首段现接受且只接受 32 位 InstanceId，并核对可信的实例 header；Cap’n Proto 中两个需要该模块的系统 Worker 都明确登记，模块闭包构建测试及双实例真实 workerd 启动通过。

共享发现凭证现在从已校验的显式清单建立内存视图：实例停止后仍只可发现自身，移除登记即撤销该凭证；运行时读取到与登记不一致的 token 时拒绝发布路由。A/B 实进程回归覆盖这些状态变化，并验证两实例 Dashboard Host 分别签发的短会话只在所属 Host 生效。

同一共享 HTTP 入口的 A/B 实进程回归现还用相同名称分别创建 KV namespace、R2 bucket、D1 database 和 Queue，验证两实例各自可读取本地资源、对方 deployer 凭证不能跨路径读取；KV 的两份公开 ID 也不同。相同 KV key、R2 object key 和 D1 table 分别写入 A/B 不同值后均从本实例读回。两实例还各部署同名 Worker，以正式 pinned workerd 分别返回本实例的内容；带伪造实例 header 的请求不会串路由，Worker Host 上的管理样式路径仍由 Worker 处理。A 的 Worker 向同名 Queue 投递后，B 的 Queue backlog 仍为零；同名 DO 的 A/B 状态分别写入、交替读取也互不影响。此回归发现 DO 私有 authority 仍输出旧 `accountId`、运行时要求 `instanceId`，已在权威模型修正并补序列化测试。A/B 还共用同一份 Provider 二进制和扩展名，各自 Worker 读回本实例 Provider 工作目录中的不同文件；两个 Provider lease 的 PID 不同。强杀 A 的 Provider 后，B 的 PID 和调用结果不变；A 的已中断调用不会被静默重放，退避后新 PID 可恢复。停止 A 后其 lease 消失、B 的 PID 和调用结果仍不变。daemon 强杀并恢复后，B 的旧 Provider 被核验回收，下一次调用以新 PID 读取原实例工作目录；未 autostart 的 A 不被拉起。S3 在同一 bucket 内的 system/R2 前缀相交时由清单登记拒绝，远端两个前缀分别持有 InstanceId authority marker；假 S3 定向测试覆盖共用 R2 前缀拒绝、分离前缀可用、单 marker 残缺拒绝，以及注入相同 ResourceId/key 后两物理对象分别读回。双实例实进程用例还通过 daemon 强杀后重启检查：只恢复 autostart 的 B、回收其旧 workerd，A 保持停止；停机 A 的配置若改指向 B 的数据根，显式启动拒绝且 B 不受影响。局部 broker 测试另验证：A 的有效 session identity 送入 B 的 generation socket 时只返回拒绝状态、不移交 FD；实进程测试验证 A Provider 的迟到 ACK 不会授权下一次 attach，B Provider 仍正常。旧代次与断连的完整故障矩阵及 R1 最终验收仍待执行。

私有 session authority 的局部测试验证 A 的 session 不存在于 B 的 registry，换代后旧 session 失效。Provider attach 的私有协议现以 `OCP2` 附带一次性 16 字节 nonce，ACK 必须回显当前 nonce；不匹配或超时即销毁该 Provider，不复用控制 socket。局部 FD 故障注入覆盖正确/错误 nonce、旧 ACK 重复发送仍不能授权下一次 attach、两个 FD 不串用；双实例真实进程专项测试覆盖新协议下的同名 Provider 调用和 A 崩溃后 B 正常。测试专用 Provider 的一次性重复 ACK 故障点还在 A 的两次独立 Worker 部署中留下旧 ACK：第二次 attach 被拒绝并销毁 A Provider，B 的同名 Provider lease/调用不变，A 随后换 PID 恢复；定向双实例实进程用例通过。跨实例 FD 交叉故障的整进程注入仍未验收。

共享 Git 在途请求上限现由 `ocd.toml` 的 `[artifacts].max_concurrent_requests` 配置，一个 daemon 内所有实例及其 Git 入口共用同一 semaphore；实例配置中的旧同名字段被拒绝。局部测试覆盖两个独立数据根争用额度与释放。`[metrics].max_series` 也已移至 daemon 清单：共享指标入口按实际对外 series（含 InstanceId 标签）计数，满额只拒绝新抓取，实例停止释放占额。局部测试覆盖 A/B 争用与释放；完整资源验收仍未完成。

Images 和 Document Parser 服务都由每个实例独立创建；已删除重复的“每 account”并发 semaphore 与配置项，只保留实例内各自的 `max_concurrency`，默认有效额度仍为 2。Parser 的每版本限制继续独立生效，AI Search 不再传入无用途的账户参数。旧配置键严格拒绝；配置、真实图像变换、解析器限流和成功路径定向测试通过。

ArtifactCache 现提供不受水位限制的手动清理原语，复用索引、pin 和在途下载保护，并以目录 FD 拒绝符号链接祖先；局部测试覆盖 dry-run、在用条目、路径替换和删除失败。运行中实例经 daemon 控制 socket 清理，停止实例由 daemon 复验清单/身份、取得实例锁和核验/回收子进程后清理。`ocd cache clean` 已接入默认全局、`--instance`、`--all`、`--dry-run`：离线先取得既有 OCD 作用域锁；全局清理只识别共享的内嵌 runtime package 与更新检查副本，保留当前 package、未知目录及在线使用的更新检查文件；局部测试覆盖选择互斥、范围、锁占用、预览无写和失败报告，并有双实例实进程用例验证在线清理不跨实例、当前 package 保留。生产 daemon 现只在 `<OCD_DIR>/cache/` 物化一次已验证包，实例和共享 Gateway 复用，双实例实进程测试确认实例目录没有 runtime package 副本。native extension 的 dry-run 只读核验已有 provider lease/staging，并拒绝不可信目录。完整资源/最终 Gate 仍未验收，不能视为 R1-T21 最终验收。

长期受监督子进程在 macOS 的已验证可执行文件暂存已改为 lease 所属目录的 `staging/`，恢复和删除均按该 lease 根核验；无 lease 的 `HostProcessSpec` 短命子进程暂存在其工作目录的 `tmp/staging/`；带 lease 的短命进程将暂存放在 lease 所属目录的 `staging/`，并在进程组回收后清除 lease。workerd 的 cwd、HOME、XDG cache 和 TMPDIR/TMP/TEMP 现从实例 lease 导向实例根，生产启动缺失 lease 拒绝；同实例 Provider 的 HOME、cache 与 temp 也限制在所属实例。实例文档解析器使用 `<INSTANCE_DIR>/tmp/` 下独立私有任务目录；共享 Caddy 子进程的临时环境指向 `<OCD_DIR>/tmp/`，Caddy 只读/校验 CLI 的每次调用使用 `<OCD_DIR>/tmp/` 下独立 0700 工作目录，真实 Caddy 命令测试验证正常完成后无残留。首次 setup 暂存也位于该目录，在持有作用域锁期间独占创建并写入 owner 标记；下一次 setup 或 daemon 启动持同一锁，仅回收标记、权限、文件形状均匹配的残留，未知内容和符号链接跳过。局部测试覆盖路径归属、正常退出清理、错误路径和这类崩溃残留；Caddy 工具与文档解析器短命子进程现写入绑定可执行文件摘要的 lease；daemon 冷启动、后续 Caddy 工具调用和实例解析器初始化复用同一工作目录回收规则，只对 owner PID 已消失、目录/标记可信的目录执行经身份核验的 orphan 回收，活动或未知目录不删除。局部测试覆盖 lease 正常清除、死进程 lease 恢复、活动和未知目录保留；独立 owner 进程在写入 lease 后被真实 SIGKILL，恢复路径核验身份并回收其孤儿子进程。无 lease 的未完成工作目录因缺少可信回收证据而保留，不按年龄删除；Caddy/解析器应用级强杀端到端及完整 R1-T22 验收仍未完成。

清单派生视图现拒绝两个实例的相同或父子重叠 public base domain，冷启动和在线登记共用这项校验。ACME DNS authority 已能在同一 UDP/TCP listener 与 provider socket 上按多个 base domain 独立回答 TXT、NS、SOA；局部测试覆盖跨域 token 隔离、在线替换与删除。Caddy 私有 upstream 已通过共享 Host 路由表精确选择运行中实例，实例停止即撤销其映射，并在运行时拒绝重叠域名或与登记不一致的域名。`ocd.toml` 的 `[gateway]` 持有共享 listener/Caddyfile 设置；实例配置只声明 `[public_gateway].base_domain`。`ocd caddy` 现按 user/显式 system 作用域执行，不读取任一实例配置，也拒绝 `--config`/`--instance`。生产启动路径已改为在 OCD_DIR 持有一套 Caddy、challenge listener、provider 和私有 upstream，并通过 daemon socket 管理全局 Caddy 状态/校验/重载。局部双实例实进程测试现通过：两实例读取同一 Caddy PID，在线登记第三个域名使同一配置生效，移除后撤销该域名；operator Caddyfile 变成无效内容时重载失败，旧 Caddy PID、已生效配置和 A/B 服务不变，修复文件后重载成功；控制 CLI 的在线清单写入等待按 Gateway 验证/加载的有界耗时设置，测试失败清理亦回收已核验的 Caddy 子进程。Gateway storage 现以 `storage/.ocd-storage-id` 与 `config-state/storage.id` 双标记区分首次初始化和状态丢失；局部双实例实进程测试证明正常停机后整个 storage 根丢失会拒绝下一次启动，不会静默重签。DNS-01 provider 现于发布 TXT 前持久记录对应 base domain 的签发尝试；局部测试确认记录失败时不发布挑战，重启发现尝试过但证书整站点丢失即拒绝。公网 ACME 恢复和完整最终 Gate 仍未验收。

任务工作目录现于写入 owner 标记前以 no-follow 目录 FD 固定为 0700；此前 macOS 上的 0755 新目录会被恢复逻辑拒绝，已修正。服务层真实强杀测试分别使用 Caddy 工具和解析器的任务前缀/lease 名称，强杀 owner 后核验并回收实际存活的有界子进程与目录；测试子进程是 `/bin/sleep`，不冒充真实 Caddy/解析器命令的端到端证据。

## 1. 最终模型与安装作用域


**一个选定作用域内只有一个常驻 OCD daemon，管理多个 Instance；每个实例只有一个 InstanceId、一份显式登记的 compute.toml 和一个由该配置的 `[data].path` 指定的数据目录。OCD 自有运行状态只归属于 OCD_DIR 或 INSTANCE_DIR；配置文件位置不决定数据位置。**

| 模式 | OCD_DIR | 安装与运行 |
| --- | --- | --- |
| 用户级，默认 | `~/.open-compute/` | 普通用户安装和 `ocd setup --yes` 均不需要 root；使用 systemd user service / LaunchAgent，以当前用户运行 |
| 系统级，显式 `--system` | `/var/lib/open-compute/` | `sudo ocd setup --system --yes` 创建系统目录和系统服务；daemon 仍以发起 sudo 的非 root 用户运行 |

两种模式使用完全相同的配置、目录布局、实例生命周期和授权模型；区别只在根目录选择、OS 服务注册范围及其必要权限。不新建专用 service user，不要求普通 CLI 使用 sudo，不隐式提权；root setup 必须显式选择 `--system`。

“全局唯一”指选定的 user/system 作用域内唯一，不承诺无 root 条件下跨所有 OS 用户强制全机互斥。CLI 默认只访问当前用户的 OCD_DIR，`--system` 才访问系统 OCD_DIR；无自动探测另一作用域、接管或合并。不同作用域的端口冲突明确报错，不静默换端口。

用户根中的 `~` 指运行 UID 的 home，不由任意覆盖的 HOME 环境值重新定义；system 模式始终选择固定系统根。每个作用域的 OCD_DIR 固定；生产命令不通过任意 `--config`、cwd 或项目数据目录再创建一套 daemon。单例锁在 `<OCD_DIR>/ocd.lock`，所有启动入口先获得它；第二次启动不得删除原 socket。测试根目录注入只用于隔离测试，不成为生产多 daemon 入口。

“一个 daemon”不排除短命 CLI、workerd、Caddy、Provider 和解析器子进程。实例可独立启停；daemon 崩溃或 OOM 仍影响其全部实例，不宣称进程内硬故障隔离。

## 2. 只有两类数据目录

`OCD_DIR` 保存全局配置和共享状态；`INSTANCE_DIR` 是本文件对 **实例 `compute.toml` 中 `[data].path` 解析结果**的简称，不是额外配置项。

```text
<OCD_DIR>/
├── ocd.toml                  # 全局配置；实例清单只登记 config + autostart
├── ocd.lock                  # 作用域单例锁，不能作为 cache 清理
├── keys/                     # 唯一的全局 admin token
├── run/                      # control socket、运行 descriptor、具名内部 socket
├── gateway/                  # Caddy/ACME 持久状态和生效配置
├── cache/                    # 可重建的共享缓存、内嵌工具物化产物
├── logs/                     # daemon 日志
├── tmp/                      # daemon 的一次性临时文件
└── instances/                # 可选的默认落点，不自动发现或登记实例
    └── dev/                  # 仅为文档和 setup 向导示例
        ├── compute.toml      # 显式写入 [data].path = "./data"
        └── data/             # 此例的 INSTANCE_DIR；可在配置中改为外置路径

<INSTANCE_DIR>/               # 只以该实例 compute.toml 的 [data].path 为准
├── control.sqlite            # 唯一 InstanceId 与资源元数据
├── keys/                     # 密钥、凭证文件
├── objects/                  # 本地对象原件，不是 cache
├── runtime/                  # 实例恢复状态、Provider 工作目录及 lease
├── cache/                    # 仅可重建副本
├── logs/                     # 实例日志
└── tmp/                      # 实例的一次性临时文件
```

**`instances/` 可以由 setup 默认创建，但只是文档和 CLI 创建向导可选择的普通目录。**除第 2.1 节防止实例数据侵入全局状态的包含检查外，它没有特殊语义：不扫描子目录、不自动注册/启动、不推导 ID、不强制存数据、不根据目录名选实例，也不是独立 registry。内置位置与外置位置使用同一套配置加载、存储、生命周期和清理逻辑。

即使采用图中的默认布局，向导也必须把数据路径明确写进 `compute.toml`；运行时不能因为文件位于 `instances/` 下，就替缺失的 `[data].path` 推断默认值。把该字段改为 `/mnt/data/dev` 后，全部实例数据只写那里，不在默认 `data/` 保留副本；变更路径本身不搬迁或删除原数据。

scheduler、observability、产品数据库及其他实例业务文件都属于 INSTANCE_DIR；全局目录不另存实例业务权威。只读且内容寻址的内嵌工具可在 OCD_DIR 共享，Provider/workerd 的可变状态不能共享。

不再分别配置 state/cache/runtime/temp 根；不写入额外的 `/etc/open-compute`、XDG cache/runtime、系统 cache 或 `/tmp/open-compute-*`。安装 receipt、升级检查缓存、自有 CLI target 设置、日志和子进程物化文件也必须归入这两类数据目录。可执行文件及 OS service/LaunchAgent 注册入口仍按安装方式放置，但不在那里保存应用状态。

实例的 `compute.toml` 是显式配置输入，可由用户或 CLI 创建在项目等选定位置，不要求位于 INSTANCE_DIR，也不在数据目录复制一份配置。它的父目录不是第三个自有状态根。显式选择的远端 S3、operator 外部输入、外部工具自身状态及 OS 自行产生的日志同样不变成 OCD 的第三个本地数据根，不得被 OCD 当作自有数据清理。受管子进程的缓存和临时输出必须显式重定向；仅设置 cwd 不足以保证任意 native code 不写外部文件。

### 2.1 数据目录包含关系

以下约束作用于 `[data].path` 的真实解析结果，与 `compute.toml` 本身放在哪里无关：

- 位于 OCD_DIR 内的数据根，**只能是 `<OCD_DIR>/instances/` 的严格子目录**；禁止 OCD_DIR 本身、`instances/` 本身，以及所有非 `instances/` 子树，包括尚未命名的 `OCD_DIR/custom/`。不能只用 gateway/cache 等名称黑名单。
- 位于 OCD_DIR 外的数据根允许使用，但不得反过来包含 OCD_DIR。不同实例数据根不得相等或互相包含；相同数据根被不同配置引用、不同数据根有重复 InstanceId 均拒绝。
- 本地 objects 固定在本实例数据根内；不保留独立的外置 local object root。需要换磁盘时搬迁完整实例数据并显式更新 `[data].path`。

路径按真实文件系统解析顺序检查每一级，再处理后续 `..`；不能先折叠 `..` 使其中的 symlink 脱离检查。`instances-old/` 不属于允许子树，symlink 或 `..` 也不能绕过 containment。现有定向测试覆盖 `instances/link/../...` 拒绝与普通子目录中的 `..` 合法归一化。首次 setup 和 instance setup 使用通过检查的真实路径创建并写入配置，创建目录后再次复验；局部测试覆盖外置路径经 symlink 指向真实目录时只记录真实数据根。setup、add、启动、purge 和 restore 都遵守同一边界；不以递归 chown 或删除自动修复未知目录。

### 2.2 Socket 和临时运行状态

具名 Unix socket 全部在 `<OCD_DIR>/run/`，实例子路径以 InstanceId 区分；内部优先使用无路径的 socketpair。具名 socket 在 bind/connect/配置渲染前检查绝对路径及 **103 encoded bytes** 上限，采用短文件名；超长明确报错，不外置到 `/tmp` 或建立备用运行根。外置实例目录再长也不进入 socket 路径。

run 中的 descriptor/socket 可重建，但只能由持锁的 owner 在完成对应旧子进程身份核验与恢复后处理；不把 run 或 lease 交给通用 temp/cache 清理。

## 3. 全局清单指向配置，实例配置指定数据

### 3.1 `<OCD_DIR>/ocd.toml`

当前配置示意：

```toml
[server]
public_bind = "127.0.0.1:8787"
# 需要时显式配置 admin_bind；默认只在 loopback 合并入口。
admin_auth = { file = "./keys/admin.token" }

[artifacts]
max_concurrent_requests = 16

[metrics]
max_series = 1024

[[instances]]
config = "./instances/dev/compute.toml"
autostart = true

[[instances]]
config = "/projects/production/compute.toml"
autostart = true
```

清单只保留 `config` 与 `autostart`；`config` 唯一决定读取哪份实例配置，不复制其中的 data 路径、InstanceId、digest、PID 或服务状态。不另建 registry/全局实例数据库，不通过扫描 `instances/` 建立清单。内存索引从显式配置及实例权威重建。

共享 listener、唯一的全局 admin 凭证、Caddyfile 列表、challenge DNS、代理信任、全局 cache 策略及第 10 节列明的共享上限由本文件配置；不再配置 `daemon.state_dir`。全局 admin token 默认由 setup 生成在 `<OCD_DIR>/keys/`，配置只保存经过校验的 env/file 引用，不复制到实例目录。实例登记项仍严格只有 `config` 与 `autostart`。本文件的相对路径相对 OCD_DIR。CLI 中显式输入的相对文件系统路径先相对 CLI cwd 解析，再写成与目标配置位置一致的路径值，不能依赖 daemon cwd。

### 3.2 实例的 `compute.toml`

```toml
[instance]
name = "dev"

[data]
path = "./data"

[auth]
deployer_auth = { file = "./data/keys/deployer.token" }
read_only_auth = { file = "./data/keys/read-only.token" }

[extensions.local-files]
path = "./extensions/files"
```

**`[data].path` 是必填的唯一数据根配置，支持绝对路径或相对本配置文件的路径；缺失即报错。**上例若位于 `<OCD_DIR>/instances/dev/compute.toml`，数据为 `<OCD_DIR>/instances/dev/data/`；同一配置位于 `/projects/dev/compute.toml` 时，数据为 `/projects/dev/data/`。也可直接指定 `path = "/mnt/data/dev"`，与配置是否位于默认目录无关。

运行时从明确的配置路径加载文件，再解析 `[data].path`；不反过来从数据目录寻找配置，不把配置父目录当作数据根，不保留全局清单的 `data_dir` 字段或旧全局数据根默认值。密钥、本地对象、cache、tmp 和恢复状态由解析出的 INSTANCE_DIR 派生，其他 data 策略字段保留。

实例 deployer/read-only 凭证、存储 backend、KV/R2/D1、AI、调度、实例限额及域名声明留在实例配置；不包含 admin 凭证或权限、公共监听端口、OS service scope 或另一份账户/平台身份。secret 继续采用经过校验的 env/file 引用，OCD 生成的实例 secret 只写在该实例数据根下；配置仅保存引用。

本配置中所有相对文件路径（含 data、extension、secret 引用）都相对 `compute.toml` 所在目录解析，不相对 data 根。扩展只静态声明；跨配置不做隐式继承、层层 merge、旧配置发现或损坏时 fallback。移动配置时必须保持解析后的数据路径不变或显式更新它，不能承诺移动任意相对路径配置就自动找到原数据。

## 4. 唯一身份与 Cloudflare 边界

`InstanceId` 在新实例初始化时生成一次，持久化到 `control.sqlite` 的实例元数据，统一表示为 32 位小写十六进制字符串。可用 UUID v7 的无连字符形式生成；配置和目录名不产生身份。

重启、搬迁完整实例目录不改变 ID。已有状态身份缺失、重复、损坏或 schema 不支持时拒绝启动，不生成新 ID“修复”。status 只读，不初始化数据。复制完整目录不会创建新身份；本阶段不提供资源重写式 clone。

局部清单测试已验证：将已登记 `compute.toml` 搬到另一配置目录、仅更新清单 `config` 且保持显式 `[data].path` 不变时，重新读取仍指向同一数据根和 InstanceId；这不代替整机搬迁验收。

`instance.name` 可选、可改，仅用于展示和临时 CLI 选择；选择后立即解析成 ID。SDK/Dashboard 内部状态、target、授权、持久引用、日志和私有协议统一用 InstanceId；无名称实例必须可管理。非空名称在同一清单内唯一，不能冒充另一实例的完整 ID。

```text
/client/v4/accounts/{account_id}/…
                    │ 原始值直接解析为 InstanceId
                    ▼
             定位实例并验证权限
                    ▼
              已授权 InstanceContext
```

删除内部 Account、AccountId、PlatformId、AccountAuthority、default account、路径哈希 ID 及账户映射/派生函数；不以别名类型保留。API 的 `account_id` 原样等于 InstanceId，没有第二个值或映射表。

account 命名只属于 Cloudflare 对外线协议：包括上述路径、已支持的 `/accounts` 列表、`/memberships` 必需字段和官方 SDK/Wrangler 调用参数。全局 admin 可发现并管理全部已登记实例；实例 deployer/read-only 凭证只发现所属实例。`/user`、token verify 等由已认证凭证和实例上下文投影，不建立内部账户、用户或成员实体。内部自有 DTO 不保存 account 别名。官方 [Account Details](https://developers.cloudflare.com/api/resources/accounts/methods/get/) 要求路径 ID 长度为 32；小写十六进制是本项目的统一格式选择。

删除 AccountAuthority 不等于删除其他资源的协议行为：KV/D1/DO、Queue、consumer ID、Worker tag 等按各自当前官方合同输出和解析。资源自身 ID 已满足格式时直接使用；确需序列化投影时只在 CF 适配边界使用无状态纯函数。不保留旧 open-compute 的哈希输出，不新建有状态 projector、映射表或第二套权威；必须验证资源查询/引用往返及 Wrangler 的受支持流程。

实例数据库天然提供作用域，删除只为账户层存在的恒定列、外键、索引和查询参数，不机械改成每行重复的 instance_id。跨实例共享 key、S3 前缀、备份 manifest、密文 AAD、DO/书签/游标和 capability 需要作用域时使用唯一 InstanceId；资源、Worker 和版本之间的有效约束继续保留。

## 5. 本机权限与配置修改

OCD_DIR、INSTANCE_DIR 及其私有子目录由确定的非 root 运行 UID 持有，目录默认 `0700`；配置（含外置 compute.toml）、secret、descriptor、管理 socket 默认 `0600`。外置配置仅校验并访问已明确授权的文件，不递归接管其项目目录。系统 setup 只在安装阶段创建系统目录/注册服务并赋予该运行用户所有权，系统模式下的 `ocd.toml` 也不是 root-only `/etc` 配置。

管理 socket 只接受 **运行 UID 或 root**，无额外允许 GID、admin group、ACL 或本机角色系统。普通同 UID CLI 可直接使用；root 是显式管理通道，不是默认运行要求。Linux 使用真实 `SO_PEERCRED`，macOS 使用真实 `getpeereid`/等价内核 peer API；读取失败拒绝，禁止返回自身 UID 伪装成 peer 验证。客户端也校验目标路径及服务身份，不向错误 owner 的 socket 发送管理信息。平台接口依据见 [Linux unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html) 和 [Apple getpeereid](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/getpeereid.3.html)。

在线实例增删仍只通过 `ocd` 命令使用管理 socket，由 daemon 串行校验并原子改写唯一 `ocd.toml`；写入采用 no-follow、owner/mode、fsync/atomic rename。全局 admin HTTP 凭证仅可列出、启动和停止已登记实例；不能增删实例、改全局/实例配置、重启 daemon、执行 purge/cache clean 或指定 native executable。实例 deployer/read-only 凭证没有任何跨实例生命周期权限。运行 UID 及其配置的 native 扩展属于同一受信任主体，不声称网络 daemon 被攻破后仍有独立的同 UID 配置隔离。

校验失败不写清单；清单成功落盘后运行失败则保留明确的 failed 状态和原因，不回滚删除数据。手工配置修改只在显式重读/相应重启后生效；与在线修改发现内容冲突时拒绝覆盖。停止 daemon 时可由 owner 编辑文件，不另设离线写入 daemon 或持久 registry。

## 6. 公共入口与共享 Gateway

| 入口 | 规则 |
| --- | --- |
| 本地 HTTP / 可选 admin HTTP | 每个 daemon 各 bind 一次，默认 loopback；不为每实例分配公共端口。全局 admin API 仅在 loopback 管理入口可达；公共 bind 改为非 loopback 时必须配置独立的 loopback `admin_bind` |
| Open Compute admin API | `GET /operator/api/instances` 列出 ID、可选名称和运行状态；`POST /operator/api/instances/{instance_id}/start`、`/stop` 只操作已登记实例。只接受唯一的全局 admin token，不借用 CF `/accounts` 路径；其余管理操作仍需 `ocd` 命令 |
| CF 管理 API | 原始 InstanceId 定位实例，再验证实例和操作权限；全局 admin 有全部实例的 CF 管理权限，实例 deployer/read-only 只拥有所属实例的对应权限 |
| 无路径 ID 的发现接口 | 全局 admin token 可发现清单内实例；每个实例 deployer/read-only bearer 只对应一个 `(InstanceId, role)`；跨实例重复凭证或与全局 admin 凭证重复均拒绝，其他实例不可枚举 |
| 本地 Worker | `<worker>.<instance_id>.localhost`；Host 先分类，Worker 的管理样式路径不进入管理面 |
| Dashboard | `<instance_id>.localhost` 管理 origin；host-only cookie 和 session 绑定实例，不设置共享父域 cookie |
| 公网 Gateway | 一套受监督 Caddy 管配置的 HTTPS/可选 HTTP 端口；按域名分发，不把实例管理入口自动公开 |
| DNS challenge | 一个 UDP/TCP listener，仅处理已声明的 challenge zone |
| 内部通信 | socketpair 或 OCD_DIR/run 内的私有 socket；保留必要的自动分配 loopback TCP 端口，不暴露给用户配置 |

ID、Host、路径均不代表授权。全局 admin API 在 Host 分类后只由管理入口处理，不能从 Worker Host 或公网 Gateway 到达；请求先验证全局 token，再解析目标 InstanceId，未知实例或非法状态明确报错，不隐式创建或注册。其 start/stop 复用 CLI 管理 socket 所调用的 daemon 生命周期逻辑，不另建状态机，且不修改 `autostart`。Git Smart HTTP remote 使用 `/git/<instance_id>/<namespace>/<repo>.git` 明确选择实例，所属实例仍独立验证仓库 token；局部双实例实进程测试验证同名仓库互不接受对方 token，单实例 Git push/clone 回归亦通过。Assets 上传 token 的私有 claim 直接保存 InstanceId；双实例实进程测试验证 A/B 各自签发、交叉上传均被拒绝。Script Tail 与 Live Tail 的本地签名 WebSocket URL 使用 `/client/v4/open-compute/<kind>/<instance_id>/<tail>/<ticket>`，共享入口按路径定位，握手复核实例；双实例实进程测试验证交叉 URL 为 404、本实例握手为 101。R2 独立凭证、Dashboard 和其他非 `/accounts` 入口也必须定位并验证实例。Dashboard 会话可绑定实例 origin，但仅从全局 admin 权限派生，不成为第二种 admin token。移除/覆盖伪造内部 header；共享索引和会话以实例和运行代次隔离，停止后旧能力失效。

Gateway 的持久状态统一在 `<OCD_DIR>/gateway/`；实例只拥有域名声明和业务路由，不能注入全局 Caddy 配置。域名、base domain、challenge zone 不得重叠；Host 索引由清单和实例路由权威重建，不另存全局路由数据库。未知/停止实例流量不 fallback 到其他实例。

保留原生多 Caddyfile、CNAME、PROXY peer、TLS 校验和私有 upstream 安全合同。共享配置先渲染验证再应用，失败保留已生效配置；受信任 operator Caddyfile 与受管 listener/域名冲突仍拒绝。低端口权限由显式部署设置或端口转发解决，不以支持 80/443/53 为由把默认 daemon 提权。

## 7. 实例运行时与 Native extensions

每实例独占存储、密钥、crypto、调度器、运行任务、业务缓存、健康状态、workerd supervisor、扩展 registry/broker 和 session。不得通过进程全局“当前实例”变量切换作用域。

Provider 所有权固定为 `(InstanceId, extension_name)`；即使扩展名和二进制相同也不跨实例共享进程。实例内不同 Binding 仍可共享 Provider，但 props/session 独立；名字冲突只在所属实例检查。沿用静态扩展、facade、`services + props`、socketpair 和 FD 交付，不改成 dlopen 或业务 payload 代理。

保留首次调用启动、已打开 executable 验证、env clear、独立进程组、私有 FD、有界日志、lease/start identity、退避及 TERM/KILL/reap。Provider 可变工作数据及 lease 在本实例目录；换代撤销旧 session，停止 A 不得触碰 B 的进程、FD、lease。扩展更新通过重启所属实例生效；不热加载、不自动重放有副作用的调用。

这只是状态、通信和生命周期隔离，不是 native OS 沙箱。同 UID native code 能访问的绝对路径、网络和设备不会因 cwd 不同自动隔离；本阶段只支持 operator 信任的扩展。独占设备冲突清晰失败，不新增权限 broker 或硬件调度器。

## 8. Cache 与 temp 管理

**Cache 必须是可重建副本；清理由 owner 执行，不依赖系统清理，也不要求用户日常手动维护。**

| 范围 | 自动清理 |
| --- | --- |
| `<OCD_DIR>/cache/` | daemon 管理共享可重建缓存和工具物化副本；只清理所有实例均未使用的条目，当前 pin/正在执行的工具版本保留 |
| `<INSTANCE_DIR>/cache/` | 所属实例沿用容量上限、LRU、高/低水位及 pin 保护；产品 Cache API 的 TTL/配额仍由对应产品处理 |
| 两类根下的 `tmp/` | 创建者正常结束或失败时释放自己的临时文件；崩溃残留在取得所属锁并完成恢复后有界清理 |

自动清理复用现有 cache/maintenance 路径：启动检查过期 partial，缓存写入触发容量回收，维护周期回收已过期/已释放条目；不新增常驻清理进程或通用 GC 框架。缓存写入/物化前计算空间需求并保护并发占用；所有候选仍在使用、无法回收足够空间时拒绝新增占用并报告，不强删使用中条目，不把高低水位误当作可突破的硬磁盘保护。

数据库、对象原件、业务持久数据、密钥、Caddy 证书/ACME 状态、生效配置、进程 lease、恢复中的 staging 和未完成操作记录均不是 cache。手动清理也不得递归删除整个 cache/run/runtime 根；只能调用经过所有权检查的缓存清理逻辑，跳过 pin 并报告释放字节、跳过条目和失败原因。清理失败不能伪装成全部成功；不为清理强制停止实例。

每个临时任务使用所属 `tmp/` 中独立的私有目录。受管子进程的 TMPDIR/TMP/TEMP、HOME/XDG 缓存和日志输出按需显式指向所属根，env clear 后只传允许项；构建/升级物化、解析、Caddy/Provider 临时输出不能漏到第三处。需跨崩溃恢复的文件放明确的 runtime/staging 位置，不放可直接扫除的 tmp。

只在确认对应任务及子进程不再活动、无恢复引用后删除 temp 残留；不能只凭 mtime、PID 数值或“daemon 刚启动”判断安全。先核验 start identity/binary digest 并完成 orphan recovery，再清理；证据不足跳过并报告。全局清理不递归扫实例目录、其他 UID 或未知子目录；已登记的外置实例由自己的 owner 持锁清理。必须保留的失败诊断不归入一次性 tmp。

## 9. 生命周期与 CLI

daemon 只处理一次 OS signal、作用域锁、服务注册、公共 listener、共享 Gateway 和总退出。InstanceRuntime 接受独立取消信号并持有全部 task/child handles，不自行监听全进程退出。每实例变更串行，状态为 stopped/starting/running/stopping/failed，健康状态独立。

冷启动先检查清单中的配置路径、解析后的数据根、ID、名称、凭证和域名冲突；冲突项不按加载顺序选赢家。全局配置或 bind 失败拒绝 daemon 启动；单实例初始化失败只标记该实例。停止实例先撤路由和新任务、撤能力，再有界 drain/结束 tasks 和 children，关闭存储后释放数据锁；未结束不得报告 stopped。

以下是目标命令；新增行为需实现后才能使用：

```sh
ocd setup --yes                           # 默认用户级，无 sudo
sudo ocd setup --system --yes             # 仅系统级 setup 需要相应权限
ocd run                                  # 读取用户 OCD_DIR/ocd.toml
ocd start
ocd stop
ocd restart
ocd status
ocd instances
ocd instance setup                       # 交互式创建实例，不另装 OS service
ocd instance setup --name dev --yes       # 向导默认值也写成显式配置
ocd instance setup --config /projects/test/compute.toml --data-dir /mnt/data/test --yes
ocd instance add --config /projects/prod/compute.toml # 登记已有实例配置
ocd instance start dev
ocd instance stop dev
ocd instance restart dev
ocd instance remove dev                   # 停止并移出清单，保留配置和数据
ocd cache clean                           # 只清理全局 cache，不递归包含实例
ocd cache clean --instance dev            # 只清理指定实例的 cache
ocd cache clean --all                     # 全局及清单内各实例，逐项报告
ocd cache clean --instance dev --dry-run   # 预览，不创建目录、初始化或修改数据
ocd --system status                      # 显式选择系统 OCD_DIR，非自动提权
```

`--instance` 与 `--all` 互斥；选择器接受完整 InstanceId 或唯一名称。手动 cache clean 尽可能回收目标范围内全部未使用且可重建的条目，不受是否达到高水位限制，不附带 purge/temp 清理。自动策略仍按水位/过期条件执行。

daemon 在线时，cache clean 必须经管理 socket 交给 owner，不能由 CLI 绕过 pin 直接删文件。daemon 确认离线时，CLI 可取得相同作用域锁及必要实例锁，先核验/回收残留子进程，再复用相同清理逻辑；拿不到锁或无法验证残留进程时拒绝清理，不能把 socket 连接失败当作“已经停止”。停止实例的清理由 daemon 取得该实例锁后执行；dry-run 同样不绕过授权。

持久 start/stop 意图仅由清单 autostart 决定，CLI 或全局 admin HTTP 的单次 start/stop 都不隐式改 autostart。配置改变后由 CLI 显式重启所属实例；公共端口和作用域变更重启对应 daemon。修改 `[data].path` 不自动移动数据；必须先停止原实例并重新验证新目标，不把新目录冒充原实例身份。实例增删只影响相关实例，不实现通用 reconcile 引擎。

安装、升级和卸载每次只管理选定作用域的一套 OS service，默认保留实例数据。移除、purge、restore、全局卸载严格区分；purge 仍需原有显式确认和路径归属证明，不能因为默认实例嵌在 OCD_DIR 下就递归删除全部目录。

### 9.1 交互式创建实例

当前 `ocd instance setup` 已通过 daemon 控制 socket 创建新配置、显式数据根和实例 authority，并在局部双实例实进程测试中覆盖外置数据、不立即启动、非 TTY 未给 `--yes` 时不落盘，以及 CLI 与 daemon 不同 cwd 下的相对配置/数据路径；提示函数定向测试覆盖默认值、显式回答、非法回答和 EOF 取消。真实 PTY 端到端用例验证取消不落盘、确认后预览的规范路径与显式 `[data].path` 一致，且不 autostart/立即启动。文件发布现在使用独占创建，不在目标出现竞态时复制覆盖；预初始化回滚只删除本次创建且设备号/inode 仍匹配的文件，路径已被替换时保留新文件并报告回滚不完整，局部测试覆盖这些路径。全部失败/回滚边界仍待验收。顶层 `ocd setup` 已改为作用域单服务，拒绝 `--config` 和 `--instance`；自选实例路径只能用 `ocd instance setup`。真实 system service 安装与权限仍待验证。本段其余内容仍是待完成的验收合同。

`ocd setup` 负责选定作用域的 daemon 安装/初始化并生成唯一的全局 admin token；首次 setup 创建首个实例时复用下列同一流程。`ocd instance setup` 只向已经运行的选定 daemon 添加实例，不再安装服务、不隐式提权，也不生成新的 admin token；daemon 未运行时明确提示先启动。

向导依次收集可选显示名、配置文件路径、数据目录、是否 autostart、是否立即启动；最后展示规范化后的配置/数据路径、作用域与启动选择，确认后才创建文件或修改清单。数据目录提示展示最终绝对路径，不让用户猜测相对基准。默认配置落点可建议 `<OCD_DIR>/instances/dev/compute.toml`，默认数据可建议该配置旁的 `data/`；两项均可独立修改，目录名不成为实例身份。

向导生成的 `compute.toml` 必须显式写入 `[data].path`；采用默认布局时可写 `./data`，用户选择外置目录时写入等义的明确路径。写入后的路径解析结果必须与最终预览一致。默认目录建议只发生在创建时；加载手写配置或 `instance add` 时缺失 data 字段直接拒绝，不能复用向导默认值兜底。

`--config`、`--data-dir`、`--name` 可预填输入；`--yes` 接受明示默认值并跳过交互，但不跳过路径、权限、唯一性及已有文件检查。可用 `--autostart=false` 与 `--start=false` 明确拒绝相应默认启动选择。未提供名称和配置路径时可建议 `instances/default/compute.toml`；已占用就报冲突/要求另选，不自动覆盖或复用已有实例。非 TTY 且无 `--yes` 时在写入前拒绝；取消同样不落盘。

CLI 收集输入和确认，daemon 经已授权管理 socket 串行执行校验、独占创建实例配置及 deployer/read-only secret、初始化明确的新数据状态并登记 `config + autostart`。生成文件由 daemon 的运行 UID 持有；配置只含 secret 引用，输出不打印凭证。已有配置交给 `ocd instance add --config ...`：读取其原始 `[data].path`，不覆盖配置或改变数据路径。两条入口共用配置加载、目录边界、身份初始化和登记逻辑；`add` 不是创建向导的旧命令别名。

创建拒绝覆盖配置、secret 或接管非本平台的非空数据目录；`--yes` 不是删除/重置授权。失败回滚只能移除本次确定创建且尚未成为持久权威的文件；已初始化的数据或已尝试启动的实例保留并报告错误。两份配置指向同一数据根、重复 ID/名称、非法目录等冲突在登记和启动前检查；任何一步不得留下指向不存在配置的有效清单项。

## 10. 有边界的共享资源限制

不承诺通用的“整机总负载保证”。R1 只将以下已有计数器上移到同一 daemon 共享服务，目标配置项均在 ocd.toml；不在每实例重复一份相同共享上限：

| 配置项 | 单位、默认值 | 获取/释放与超限行为 |
| --- | --- | --- |
| `artifacts.max_concurrent_requests` | 同时在途的 Git 请求数，16 | 所有实例共享同一 semaphore；开始读取/处理 Git body 前 try-acquire，请求/流结束或错误取消释放；无额度拒绝新 Git 请求，不建无界队列 |
| `metrics.max_series` | daemon 保留的不同 metric series 总数，1024 | 包含 InstanceId 标签后的实际 series 统一计数；新增注册前检查，删除 series 时释放；到上限拒绝新增 series 并有界报告，不驱逐现有 series 或重启 daemon |

Git 超限沿用产品已声明的限流错误；metric 容量不足不能导致进程崩溃。全局/实例 cache 另按第 8 节限制。产品数据库、Worker/资源数、解析并发等仍按实例现有策略执行，不为了 R1 新建通用调度、公平分配、CPU/RSS 聚合配额或跨文件系统磁盘预算框架；现有磁盘低水位与写入保护不删除。

实例配置中的容量键已去掉旧账户维度：`hardening.max_workers`、`max_routes`、`max_resources_per_kind`，以及 `workflows.max_instances`、`max_active`、`max_total_state_bytes`。旧 `*_per_account`／`max_account_state_bytes` 键严格拒绝，不保留别名；默认额度和单实例实际作用域不变。

内部“实例不存在”错误统一使用现有 `INSTANCE_NOT_FOUND`；旧 `ACCOUNT_NOT_FOUND` 私有码不再解析。Cloudflare v4 边界仍把该条件映射到原有的 not-found 线协议响应。

全局 `/health/live` 表示 daemon 存活，ready 表示共享入口可服务；实例 readiness 单独报告。日志/业务 metrics 以 InstanceId 区分，单实例 degraded 不触发全 daemon 重启。资源回归只验证本节两个明确计数器及已有实例限制，不以一次压测宣称硬资源隔离。

## 11. 备份、恢复与共享状态归属

`backup restore` 的目标配置须已在所选 OCD 作用域的清单中显式登记；未登记配置即使数据目录空且不与其他实例重叠也拒绝。

实例数据备份以 `[data].path` 解析后的 INSTANCE_DIR 为边界，保护身份、密钥及业务持久数据。`compute.toml` 可能位于数据根之外，由 operator 按清单里的实际配置路径另行一并备份，不假称复制数据目录就包含配置；默认 instances 布局也遵守同一规则。远端对象仍按产品备份合同处理，不能假称本地副本包含 S3。实例 cache/tmp 和具名 socket 不进入备份，可重建工具副本不要求备份；实例备份不包含全局 Gateway。

**共享状态由 operator 独立备份，R1 不新增机器备份引擎。**备份范围包括 OCD_DIR/ocd.toml、全局必需 secret、Gateway 的证书/ACME storage 与已生效配置，以及引用的 operator 配置输入。缓存、临时 challenge TXT、socket、PID/运行 lease 不作为恢复输入；外部输入需 operator 自行一并保护。全局备份不递归吞入默认 instances，避免混淆实例备份归属；secret 备份保持私有权限，不进日志或 support bundle。

本阶段的整机冷恢复顺序固定为：停止 daemon 及全部 children → 恢复全局配置/Gateway 持久状态与权限 → 恢复各实例 compute.toml、数据目录及对应远端数据 → 核对配置路径、data 路径、ID/冲突 → 启动 daemon。配置搬迁时 operator 更新全局清单的 config；数据搬迁时更新对应 compute.toml 的 `[data].path` 并复验相对引用，不通过旧路径搜索自动兜底。

已初始化 Gateway 的证书/ACME storage 丢失时拒绝自动批量重签；全新 setup 与状态丢失必须区分，恢复备份或由 operator 明确重新初始化。实例恢复不得覆盖共享 Gateway；global cache clean、instance purge 和目录权限处理都不得触碰证书及其他实例。

当前启动检查除双标记外，还按内嵌 Caddy 依赖的 [CertMagic v0.25.3 存储键布局](https://github.com/caddyserver/certmagic/blob/v0.25.3/storage.go)核验已有站点的 `.crt`、`.key`、`.json` 三件套均为私有、非空、非符号链接文件；缺一个即在 Caddy 启动前拒绝。该版本的[文件存储](https://github.com/caddyserver/certmagic/blob/v0.25.3/filestorage.go)以 0700 建目录、0600 写文件。DNS-01 provider 在 TXT 发布前于 `gateway/config-state/attempted/` 持久记录 base domain；之后的启动、Caddy 子进程重启和配置重载若缺对应 wildcard 证书整站点，即拒绝自动重签。TLS 实际探测通过后，daemon 另在 `gateway/config-state/certified/` 记录成功证据。局部缺件、符号链接、整站点目录丢失、标记写入失败及重载前拒绝测试通过；首次签发尝试失败后重启也会保守拒绝，需要 operator 核实 ACME 状态并恢复或明确重新初始化。尚未做公网 ACME 签发/恢复实环境验收，不能将 R1-T15 标为完成。

## 12. Day1 实施原则

本次只保留一个现行模型：同一作用域单 daemon、唯一 InstanceId、两类数据根、显式 config → `[data].path` 加载链。旧 config/state/cache/runtime 路径、路径哈希 ID、账户别名、旧 API 私有字段、旧 AAD/snapshot/hash 输出不保留读写分支、backfill、alias、fallback 或迁移服务。唯一协议兼容义务是项目明确支持的官方 Cloudflare 行为，不是旧 open-compute 实现。

已发布数据库 migration 的文件名、顺序和字节不可修改；需要改变当前 schema 时追加 migration。不能安全接纳的旧状态明确拒绝并保留原数据，不在启动、setup 或清理中自动重置。新目录执行完整当前迁移链后只有一个现行模型；不为了旧开发数据保留账户层。

实施按职责闭环推进，不按预先枚举的文件名单判断完成：

- [ ] 身份/存储：统一实例权威，删除账户维度，同步所有路径、密文、资源引用和私有协议的生产者与消费者。
- [ ] 目录/权限：固定两类根与显式 config/data 职责；instances 只作创建默认值；保留用户级体验，统一路径包含检查、owner/mode、真实 peer 校验、同一清单写入与作用域单例。
- [ ] 生命周期/入口：独立 InstanceRuntime、共享 listener/Gateway、全部入口授权、跨实例隔离与子进程恢复同时接通。
- [ ] 清理/备份/工具：补独立 instance setup 向导并复用创建能力，登记既有 config；同步 cache/temp 回收、CLI cache clean、外置配置/共享状态备份、安装/升级/purge/restore 和 SDK/Dashboard 引用。
- [ ] 收尾：删除旧实现和无效参数，同步维护合同、生成输入、例子和测试；完成对应静态检查、coverage 与一次最终 Gate。

以上是开发顺序，不是发布多套过渡架构。涉及正式 workerd 私有 seam 时同步 fork、pin 和验证，不假设旧二进制支持新协议。本地实现与最终 Gate 的结果见文首；外部环境资格仍按实际证据单独判定。

账户残留检查覆盖生产领域类型、配置、数据库、私有 runtime 数据、SDK/UI 状态和全部调用边界，不以某个目录豁免代替检查。允许的 account 词只在 CF wire 参数/DTO/相应协议测试及不可改写的已发布 migration 中；不得藏入第二个身份权威。OS 用户变量明确命名为 uid/gid/service_user。默认 root、旧路径发现、外部临时目录、全局清单的 data_dir 副本及按目录推断 data 的行为也需同样清除；这不包括必须保留的实例 `[data].path`。

## 13. 回归与交付

跨实例场景同时运行 A/B，刻意使用相同 Worker/资源/扩展名，并在共享 key 测试中注入可碰撞的局部 ID。以下是目标断言清单，不表示每项外部环境资格均已通过；实际本地 Gate 与未验证环境见文首。

| 编号 | 必须证明 |
| --- | --- |
| R1-T01 作用域与安装 | 默认 setup/CLI 不用 root；显式 system setup 后 daemon 仍为原非 root 用户；同一 OCD_DIR 只有一个持锁 daemon，改 cwd/HOME 不创建另一用户根，重复启动不破坏原 socket；不同 scope 无隐式 fallback |
| R1-T02 唯一身份 | 初始化一次、重启/搬迁数据不变 ID；移动配置且保持 data 指向时不变 ID；改 data 路径不自动迁移/删原数据；损坏身份不重建；名称变更不影响引用；无名称实例可管理；内外 ID 同值 |
| R1-T03 目录边界 | data 在 instances 严格子目录或完全外置合法；OCD_DIR 本身、instances 本身、任意非 instances 子树（含 custom/instances-old）、父目录重叠、实例互嵌、重复配置/数据根/ID、symlink/.. 逃逸及独立 object root 拒绝；purge/restore 不碰其他 owner |
| R1-T04 CF 线协议 | account_id 原样使用 InstanceId；列表/成员等支持面仍可用；资源 ID、Queue/consumer、Worker tag 的查询引用往返和正式 Wrangler 部署通过，无旧 hash 兼容 |
| R1-T05 HTTP 凭证与管理 | 唯一全局 admin token 可列出/启动/停止 A、B 并访问授权的 CF 管理面；A 的 deployer/read-only token 无法操作/枚举 B 或访问全局 admin API；跨实例/跨角色及与全局 admin 重复凭证拒绝；HTTP 路由只提供 list/start/stop，不能改 ocd.toml、扩展路径或执行其他 CLI 管理操作；Worker Host/公网 Gateway 不可达该路由 |
| R1-T06 Host 隔离 | 同名 Worker 同时服务；未知 Host 拒绝；Worker 的管理样式路径不进入管理面；伪造内部 header 无效 |
| R1-T07 数据隔离 | KV/R2/D1/Queue/DO 等同名资源互不读写；S3 key prefix 隔离；无全局当前实例切换 |
| R1-T08 密文与备份 | 跨实例密文/书签/capability 拒绝；新格式重启可读；旧格式拒绝且不删原数据；外置 compute.toml 与 data 的备份归属和恢复路径明确，默认目录没有另套规则；restore 身份一致 |
| R1-T09 独立启停 | CLI 与全局 admin HTTP 共用生命周期逻辑；A 重启/启动失败不终止 B；停止先撤入口并收回 tasks/children，最后才释放存储锁；HTTP start/stop 不改变 autostart |
| R1-T10 恢复 | daemon/实例 crash 后恢复不误杀其他实例、不遗留有效旧能力；完整校验 lease/start identity；只恢复清单 autostart |
| R1-T11 Provider | 同名同 binary 的 A/B Provider 有不同 PID/cwd/lease，实例内多 Binding 共享语义不变 |
| R1-T12 Session | A 的 generation/session/FD 不能 attach B；迟到 ACK、旧代次、断连及停止均 fail closed |
| R1-T13 扩展故障 | A 的 crash/backoff/熔断不影响 B；只回收所属进程组，不自动重放 native 副作用 |
| R1-T14 共享网关 | 一个 Caddy/一个 challenge listener；域名/zone/Caddyfile 冲突拒绝；原生配置及私有 upstream 仍受约束 |
| R1-T15 网关失败与恢复 | 无效新配置不破坏有效服务；未知 zone/停实例无 fallback；全局备份与实例备份分离；丢失 ACME storage 不自动重签 |
| R1-T16 Socket 与输出根 | 具名 socket 只在 OCD_DIR/run，超长无外置 fallback；自动 loopback 端口不冲突；受管子进程的 cache/tmp/log 不写第三根 |
| R1-T17 非 REST 表面 | Git/R2 凭证、上传 token、tail/WebSocket、Dashboard 登录和 cookie 全部验证正确实例 |
| R1-T18 运维 | 清单只登记 config/autostart，add 不重写 compute.toml 或忽略 data；remove 保留配置/数据；不扫描 instances 自动登记，外置 data 不留默认副本；安装升级只管理选定 scope 服务；未知/运行中数据 purge 拒绝；status/dry-run 不初始化数据 |
| R1-T19 明确资源边界 | A/B 合计 Git 在途请求不超过共享上限，取消后释放；总 metric series 不超过配置；已有实例限额仍有效，单实例 degraded 不触发整 daemon 重启 |
| R1-T20 Peer 与配置写入 | Linux/macOS 真实 socket 验证 owner/root 允许、其他 UID/peer 获取失败拒绝；0700/0600 权限有效；同 UID CLI 无 sudo 改清单，写入失败/内容冲突不覆盖有效配置 |
| R1-T21 Cache clean | 自动水位/LRU/pin 有效；全局/单实例/all 范围准确、选择器互斥；共享工具在任一实例使用时不可删；dry-run 不写；在线走 owner、离线需锁和 orphan 验证；释放/跳过/失败报告真实 |
| R1-T22 Temp 安全 | 正常退出回收私有 tmp；崩溃后先恢复再扫；活动任务、恢复引用、其他实例及身份不明文件不可按年龄误删；secret、证书、lease、业务原件从不进入缓存回收 |
| R1-T23 交互式创建 | instance setup 向导/--yes/取消/非 TTY 行为明确，不另装服务；config 与 data 可独立指定，不同 CLI/daemon cwd 下预览与实际路径一致；生成配置含必填 data.path，手写缺失即拒绝（含默认 instances）；重复/非空未知目标/--yes 不覆盖；新增失败不留悬空登记、不删已初始化数据；权限及启动选择正确 |

文档改动只要求 `git diff --check`、示例语法、链接/索引及目标一致性检查，不构建 Rust、不下载 LFS runtime、不宣称上述产品回归通过。实现后的静态检查、正式 pin、coverage ≥90.00% 和单轮最终 Gate 遵循 [仓库规则](../AGENTS.md) 与 [测试规范](references/testing.md)，不降低门槛或多轮重跑掩盖失败。

真实 Linux/macOS peer、多用户权限、user/system 服务、GUI/TCC、低端口和公网 DNS/ACME 按实际执行证据记录；需权限的操作先授权，缺证据不得标成已验证。实现完成后按 [文档生命周期](references/README.md) 精简为用户结果、持久边界、验证和接受限制，不长期保留过程清单。

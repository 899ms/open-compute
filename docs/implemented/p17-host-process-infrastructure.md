# P17：宿主子进程管理基础设施

状态：**implemented（2026-09-17）**。

P17 将当前宿主子进程共有的安全启动和回收能力收敛到 `open-compute-runtime`，并把 Xberg 文档解析 child 迁移到该唯一实现。它不改变
[Host authority](../references/host-authority.md)，也不为尚未存在的 Gateway、Extension Provider 或 Browser child 预建 Manager。

## 当前合同

`VerifiedLaunchImage` 持有由产品 authority 预先打开并验证的 executable；通用层不搜索 `PATH`、不下载 runtime，也不重新选择版本。
`HostProcessSpec` 明确给出参数、完整环境、working directory、stdin、deadline 以及 stdout/stderr 上限。`run_host_process` 复用现有
runtime owner，统一负责：

- `env_clear()` 后只注入声明的环境变量；
- 从已打开的 executable identity 启动独立 process group；
- 并行写入 stdin 并有界读取 stdout/stderr；
- deadline、取消、输出 overflow 和 owner 失败后的 TERM/KILL/reap；
- 返回脱敏、定长的 `BoundedOutput`，不公开 raw child 或可任意 signal 的 PID handle。

workerd 的 verified-fd、lease、orphan fencing、readiness 和 generation restart 仍由 `WorkerdSupervisor` 拥有，但与短命 child 共用同一底层
process owner。Xberg 保留 OCDP、CPU/address-space rlimit、一次一进程和稳定错误码，只删除了其重复的 Tokio spawn、pipe reader、drop guard
和 kill/reap 实现。

## 容量与 ownership

当前产品只有一个正式 workerd generation 和短命 Xberg child：workerd 的单 generation 约束由 supervisor 执行；Xberg 的全局、account
和 Version semaphore 继续由 `DocumentParserBindingService` 执行。因此没有增加一个只转发现有两个上限的 speculative Process
Coordinator。未来真正加入 Gateway、Provider 或 Browser child 时，它们必须复用 `VerifiedLaunchImage` 和同一 process owner，并在出现跨产品
FD/child 竞争后于 composition root 增加一个实际共享的总预算。

每个产品继续拥有自己的协议和状态机：

- workerd：control-fd listen、HTTP readiness、generation fencing、restart 与 orphan lease；
- Xberg：单个 OCDP frame、rlimit、deadline 和不重试的转换结果；
- 后续 Gateway/Provider/Browser：各自的 readiness、session 和 restart，不抽象成 `Supervisor<Policy>`。

## 验收覆盖

runtime 定向回归覆盖显式 cwd、清空环境、stdin 完整传输、stdout 内容、stderr cap/overflow 和 overflow 后及时回收。既有 runtime suite 继续覆盖
deadline、取消、leader/descendant 回收、reader/wait failure、lease identity、PID/PGID 校验和 macOS verified-fd staging。parser 回归覆盖
spawn/input/output/timeout/exit/resource-signal 分类以及稳定公开错误映射。

实现没有新增依赖、第二套 supervisor、兼容 wrapper 或运行时下载路径。

返回[完成索引](README.md)。

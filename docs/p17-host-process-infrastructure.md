# P17：宿主子进程管理基础设施

状态：**planned（2026-09-16）**。本文冻结 workerd、Extension Provider、Browser Runtime 与文档解析 child
共享的进程所有权边界；实现和产品 Gate 尚未完成。

## 1. 结论

open-compute 需要一套通用的宿主子进程基础设施，但不建立一个用泛型 policy 驱动所有产品的万能 supervisor。统一范围只包括：

- 已验证 executable 的安全启动；
- environment、working directory、继承 fd 和 stdio 边界；
- 独立 process group、唯一 owner、TERM/KILL/reap；
- bounded/redacted stdout/stderr；
- process identity、长期 child lease 与安全 orphan fencing；
- 全局 child/FD 预算、脱敏 inventory、metrics 和 shutdown 协调。

workerd、Provider、Browser 和 Xberg 继续拥有各自的 readiness、协议、session、restart 和公开错误状态机。IPC 不进入通用进程层。

```text
ocd composition root
│
├── Host Process Runtime                 open-compute-runtime
│   ├── verified launch
│   ├── process-group ownership
│   ├── bounded/redacted stdio
│   ├── TERM -> KILL -> reap
│   └── identity / lease / orphan primitives
│
├── Process Coordinator                  open-compute-service
│   ├── global child/FD permits
│   ├── sanitized process inventory
│   ├── shutdown dependency order
│   └── aggregate metrics
│
└── Domain Managers                      owning product modules
    ├── WorkerdSupervisor
    ├── ProviderManager
    ├── BrowserManager
    └── DocumentParserRunner
```

这不会改变“一个 `ocd` authority + 同时一个正式 workerd generation”的架构。单文件发行也不表示只运行一个 OS 进程；现有
Xberg self-derived child 已证明这两件事可以同时成立，见[单二进制分发](references/single-binary.md#磁盘与进程)。

## 2. 当前基线

`open-compute-runtime::process` 已实现 bounded execution、process group、TERM/KILL/reap、verified-fd execution、redacted output
和部分 lease/orphan 原语；workerd supervisor 另外拥有长期 owner、readiness、generation fencing 与 restart actor。

文档解析 child 当前在 `open-compute-service` 中单独实现 `env_clear()`、process guard、deadline、bounded pipe 和强制回收。这些重复说明
底层 ownership 可以抽取，但 Xberg 的“一次一帧、一次一进程”不能成为长期 runtime 的状态机。

[W3 Extension](workerd/w3-user-extensible-native-bindings.md) 与 [P19 Browser Run](p19-browser-run.md) 都需要相同的安全启动和回收原语，
但前者按 package/version 复用 Provider，后者由 BR-G0 选定引擎后确定 session/pool 模型。因此现在应固定底层合同，不预先统一它们的
产品状态机。

## 3. 第一层：Host Process Runtime

该层保留在 `open-compute-runtime`，不新增 crate。它提供具体类型和函数，不增加只有一个实现的 trait、factory 或 policy framework。

概念接口：

```rust
struct SpawnSpec {
    key: ProcessKey,
    image: VerifiedLaunchImage,
    args: Vec<OsString>,
    environment: ExplicitEnvironment,
    working_directory: PathBuf,
    inherited_fds: Vec<FdMapping>,
    stdio: StdioPolicy,
    lease: Option<LeaseSpec>,
}

fn spawn(spec: SpawnSpec) -> Result<OwnedProcess, PlatformError>;
```

精确 Rust API 在实现阶段按现有代码最小抽取；上述名称不要求先建立一套 speculative public framework。

### 3.1 `VerifiedLaunchImage`

进程层不负责下载、选择版本或验证产品 package。对应 authority 先完成验证，再交付一个保持 executable identity 的 launch image：

| Child | 验证来源 |
| --- | --- |
| workerd | formal workerd lock、embedded archive、binary digest 与版本输出 |
| Xberg | 当前正式 `ocd` executable 的隐藏内部模式 |
| Browser | BR-G0 后唯一正式 browser lock、archive、文件集与 executable digest |
| Provider | operator 安装后的 immutable Extension Package 与目标平台 binary digest |

Linux 优先执行已经打开并验证的 fd；macOS signed bundle、多文件 Browser runtime 和 executable staging 使用各自已资格化的 launch
contract。通用层不把所有产物强行降成单文件，也不搜索 PATH、读取 tenant path 或运行时下载。

### 3.2 `OwnedProcess`

`OwnedProcess` 是一个 child process group 的唯一 OS owner：

- spawn 后验证 PID、PGID 和 group leader；
- 持有 child wait/reap 权限以及 stdout/stderr readers；
- 提供 exit notification、graceful TERM、deadline 后 KILL 与完整 process-group reap；
- owner task 失败或对象异常 drop 时 fail-safe KILL/reap；
- 永不把 raw child、PID signaling 或 unbounded pipe 暴露给产品 handler。

通用层返回结构化、脱敏的 `ProcessExit`，最多包含 exit code、signal、超时/overflow/reader failure 分类和 bounded byte count。原始 argv、
environment、路径、token、payload 与 stderr 正文不进入 snapshot、metrics 或 tenant response。

### 3.3 fd 与资源边界

spawn 默认 `env_clear()`、独立 process group、明确 cwd、关闭未声明 fd，并只继承 `FdMapping` 列出的 descriptor。stdio 限额和 reader
必须在 spawn 前完成，不能在 child ready 后补装。

CPU、RSS/address-space、sandbox、profile 和网络边界由产品已验证的启动模式负责；通用层只承载确定的参数/fd，不提供任意 `pre_exec`
closure、shell 或用户自定义 hook。这样保持 `unsafe_code = "forbid"`，也避免假装不同 runtime 有相同的 OS containment。

## 4. 第二层：Process Coordinator

Coordinator 位于 `open-compute-service` composition root。它不持有所有 child，不替 Domain Manager 发送 signal，也不实现通用 restart actor。
每个 child 始终只有一个 Domain Manager owner。

Coordinator 只负责：

1. 发放全局 `ChildPermit`，限制同时存在的 supervised root process 和平台 fd 总预算；
2. 汇总低基数 `ChildKind`：`workerd`、`document_parser`、`extension_provider`、`browser`；
3. 发布脱敏 inventory：opaque key、kind、state、PID/PGID、launch digest、started-at 和最后退出分类；
4. 汇总 running、spawn failure、crash、forced kill、reap failure、stdio overflow 指标；
5. 在 `ocd` shutdown 时按静态依赖顺序调用 Domain Manager 的 drain/stop；
6. shutdown 完成前断言所有已登记 process group 被 reap、permit 和 reader task 归零。

Provider ID/version、Browser target、tenant/account、argv、endpoint 与 token 不作为 metrics label。Coordinator memory 是当前进程状态，不是
authority；持久 package、session、grant 与 deployment 仍由 SQLite/immutable descriptor 拥有。

全局 permit 是安全硬上限，不替代各产品 admission：Browser session capacity、Provider active-version/session 上限、Xberg 并发和 workerd
单 generation 规则仍由对应 Manager 执行。

## 5. 第三层：Domain Managers

| Manager | 生命周期 | Readiness | Crash/restart |
| --- | --- | --- | --- |
| `WorkerdSupervisor` | 单例、平台启动时拉起、generation-scoped | control-fd listen + authenticated HTTP probe | bounded restart；决定 runtime admission/readiness |
| `ProviderManager` | 按精确 package/version/target 懒启动并复用 | Host ABI/package/schema handshake | 全部 session 失效；有 pin 才 bounded restart |
| `BrowserManager` | BR-G0 后确定的 session/pool 模型 | browser/CDP 与 profile contract | 受影响 session 标记 lost；按产品容量恢复 |
| `DocumentParserRunner` | 每次转换一个短命 self-derived child | 无独立 readiness | 不重启；只使当前转换稳定失败 |

Domain Manager 负责自己的 protocol task、readiness deadline、session/refcount、backoff、stable error mapping 和 health projection。不要把
`ProviderManager` 或 `BrowserManager` 塞进 `WorkerdSupervisor`，也不要为这四类 child 建立一个 `Supervisor<Policy>`。

IPC 保持产品所有权：

- workerd：control fd、内部 listener 与功能性 probe；
- Xberg：单个 OCDP stdin/stdout frame；
- Browser：选定 engine 的 CDP/WebSocket；
- Extension Provider：Cap'n Proto control plane，以及由 Broker 授权的 workerd-to-Provider direct session channel。

## 6. Lease 与 orphan fencing

只有可能跨 `ocd` crash 存活的长期 child 写入 secret-free lease。至少固定：

```text
schema version
child kind + opaque key hash
pid + pgid + OS process start identity
binary/package digest
launch-contract digest
```

恢复时必须同时验证 lease ownership、PID/PGID、group leader、start identity、binary/package digest 和 launch contract。完整匹配才允许
fence/reap；未知、歧义或不匹配的进程绝不 signal，并使对应 capability fail closed。

重启后 IPC 与 in-memory capability 已丢失，Day 1 不重新接管旧 workerd、Provider 或 Browser session。Manager 只清理已验证 orphan，
再按当前 authority 启动新 generation。短命 Xberg 不采用可恢复 session lease。

## 7. Shutdown

composition root 使用固定依赖顺序，不把它变成数据驱动 DAG：

1. 关闭公开 admission、Worker upload 与新的 Browser/Provider/parser acquire；
2. workerd、Browser 和 Provider 开始 bounded drain，Provider/Browser 在 workerd 仍可能完成在途调用时保持可用；
3. deadline 后停止并 reap workerd，旧 generation capability 全部失效；
4. 停止并 reap Browser 与 Provider process groups；
5. 取消剩余 Xberg task；
6. Coordinator 断言 inventory、process group、fd permit、reader 和 lease 均已收敛。

任何 Manager 的 stop failure 都不能跳过后续 KILL/reap；错误被聚合成脱敏 shutdown diagnostics。

## 8. 实施顺序

1. 从现有 `runtime::process`/workerd owner 抽取产品无关的 verified spawn、`OwnedProcess`、stdio 和 signal/reap 原语；
2. 迁移 Xberg 使用该层，保持 OCDP、limits、错误与一次一进程行为不变；
3. 增加 composition-root permit/inventory/shutdown Coordinator；
4. W3 `ProviderManager` 使用同一 owner，实现自己的 lazy start、handshake、session 与 restart；
5. BR-G0 选定 Browser engine 后复用该 owner，不预先抽象未知 pool 模型；
6. 只有实现中出现相同的第三份 restart/backoff 代码时，才抽取小型 helper。

## 9. 验收

- 每类 child 都从经过正式验证的 launch image 启动，不搜索 PATH、不下载、不继承环境；
- spawn failure、reader failure、deadline、TERM failure、KILL、leader exit 后 descendant 存活和 wait failure 均有确定回收；
- PID reuse、PGID mismatch、start identity/digest/contract mismatch 与未知 lease 全部 fail closed，且不误 signal；
- 全局和产品 capacity 同时生效，一个产品耗尽预算不会绕过硬上限；
- inventory、logs、metrics、status、support bundle 和公开错误不泄漏 secret、payload、路径、argv 或内部 endpoint；
- `ocd` crash/restart 与正常 shutdown 后不存在已登记 orphan、fd、reader task、permit 或私有临时目录泄漏；
- Xberg、Provider、Browser 和 workerd 的 readiness/restart/session 行为仍由各自 Gate 覆盖，不以通用 fixture 代替真实 runtime Gate。

返回[文档索引](README.md)。

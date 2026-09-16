# W3：用户可扩展原生 Binding 与 Provider 子进程

状态：**planned（2026-09-16）**。本文冻结 Day 1 架构与安全边界；实现、正式 workerd fork pin、产品 Gate 和
macOS XPC 真实环境资格尚未完成。

## 1. 用户结果与结论

open-compute 需要允许 operator 安装自己实现的扩展模块，并让普通 Worker 以 Binding 风格调用：

```ts
const value = await env.MY_EXTENSION.lookup("key");
```

扩展可以由用户实现文件系统、本地数据库、设备 SDK 或 macOS XPC 等宿主能力，调用链不使用 HTTP。Day 1 固定为：

1. 用户扩展包同时包含一个 **Extension Worker** 和一个或多个目标平台的 **Native Provider** executable；
2. Extension Worker 用 `WorkerEntrypoint` 暴露用户定义的 JavaScript RPC API；
3. Native Provider 运行在独立子进程中，调用文件系统、XPC 或其他宿主 API；
4. workerd fork 只新增一个通用、私有的 `HostExtensionPort` JSG capability，不内置每种扩展的业务接口；
5. `ocd` 安装、校验、启动、监督和回收 Provider，并作为 Cap'n Proto Broker 授权、建立和撤销 session；
6. consumer Worker 到 Extension Worker 使用 workerd 原生 RPC；`ocd` 完成控制面授权后，Extension Worker 通过 workerd 与 Provider
   的 session-scoped Cap'n Proto 直连数据面调用；
7. Native Provider 是 **operator-installed / operator-trusted code**，不是任意 tenant 可上传的 native code；
8. 不把用户动态库 `dlopen()` 到 `ocd` 或 workerd，不给 Provider 公网或控制面 listener，也不自动从网络下载扩展。

这套机制中的用户扩展是真正的运行时安装模块。平台内置的只是固定 ABI、生命周期和授权边界，不随每个用户扩展重新发布
`ocd` 或 workerd。

## 2. 术语与所有权

| 名称 | 含义 | 所有者 |
| --- | --- | --- |
| Extension Package | manifest、Extension Worker bundle、Provider binaries、类型、协议 schema 和 digest 的不可变集合 | operator 安装，`ocd` 校验和持久化身份 |
| Extension Version | 一个 package digest 对应的不可变版本 | SQLite authority |
| Extension Worker | 用户提供的 Worker 模块，以 `WorkerEntrypoint` 暴露 RPC 方法 | workerd isolate |
| Native Provider | 用户提供的目标平台 executable，执行宿主调用 | `ocd` 子进程 supervisor |
| HostExtensionPort | Extension Worker 可见的私有 JSG transport；只提供二进制 unary/stream 调用和 dispose | workerd fork |
| Provider Session | 已绑定一个 extension binding、descriptor digest 与 grant 的 Cap'n Proto capability | `ocd` 授权，Provider 执行 |
| Direct Session Channel | `ocd` 创建并通过 fd-backed capability 分发的 workerd-to-Provider Unix socketpair | `ocd` 建立和 fence，端点分别由 workerd/Provider 持有 |
| Extension Binding | consumer Worker 环境中的 RPC stub，指向精确 Extension Version/entrypoint | Worker immutable descriptor |
| Grant | operator 对某个扩展版本批准的宿主权限请求及其规范化 digest | SQLite authority |

Extension Worker 不是权限来源。它只能使用 `ocd` 已批准并在装载时注入的 `HostExtensionPort`。Native Provider 也不是资源、部署
或租户身份 authority；它只处理已打开 session 中的业务调用。

## 3. 当前基线与需要补齐的能力

### 3.1 已可复用

- 当前 Service Binding 已保持 workerd 原生 Request/Response、stream、callback、`RpcTarget` 和 JS RPC 语义，不转换成自定义
  HTTP JSON RPC，见[现有实现结果](../implemented/p3-2-service-bindings.md)。
- Cloudflare 官方 Service Binding RPC 允许一个 Worker 以普通方法调用另一个 Worker 的 `WorkerEntrypoint`，适合作为 consumer
  到 Extension Worker 的公开 API：<https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/>。
- WorkerLoader 已能按不可变 loader key 装载用户模块、注入受约束 dynamic env，并保持 capability 生命周期。
- `ocd` 已有完整 workerd supervisor；文档解析还会按任务启动同一 `ocd` executable 的隔离 Xberg child，证明“单文件发行”不等于
  “只允许一个 OS 子进程”，见[单二进制分发](../references/single-binary.md#磁盘与进程)。
- Xberg child 已有 environment clearing、独立 process group、bounded stdio、deadline、signal、强制回收和脱敏诊断，可复用底层
  process-ownership 规则，但不能直接复用其一次一帧、一次一进程的上层状态机。
- workerd、Provider、Browser 与 Xberg 共享的 spawn/ownership/reap/lease/预算边界由
  [P17 宿主子进程管理基础设施](../p17-host-process-infrastructure.md)统一；W3 只拥有 Provider 状态机和 Extension IPC。

### 3.2 workerd 缺口

workerd 的 Binding 本身是注入 `env` 的显式 capability；JSG 是 C++ 对 JavaScript 暴露原生 resource type 的正式机制：
<https://github.com/cloudflare/workerd/blob/main/docs/jsg.md>。

但是 standalone `ExternalServer` 当前只支持 HTTP、HTTPS 和 raw TCP，配置 schema 对 Cap'n Proto RPC 仍标记 TODO：
<https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp>。内部 `JsRpcTarget` 负责完整 JavaScript RPC 值、callback、
promise 和 external 生命周期，不作为用户 Provider 的稳定 Rust/C++/Swift ABI。

因此 W3 必须在 fork 中增加一个窄的 Host Extension channel；不能声称 stock workerd 已经提供可直接配置的外部 Cap'n Proto
Binding。

## 4. 进程模型

现有架构规则应解释为“一个 `ocd` authority + 一个正式 workerd runtime generation”，而不是绝对禁止其他 child：

```text
ocd                                      唯一 authority、公开 listener、data-dir owner
├── workerd                              同时恰好一个正式 runtime generation
├── provider: com.acme.xpc@1.2.0         长期、版本化、受监督
├── provider: com.example.fs@3.0.0       长期、版本化、受监督
├── provider: com.example.fs@2.4.1       旧版本 drain 时可暂时共存
└── ocd __document-parser-v1             Xberg，每个任务一个短命 self-derived child
```

每个 Provider 进程的唯一 key 是：

```text
(extension_id, extension_version, package_sha256, platform_target)
```

同一精确版本被多个 Worker 绑定时共享一个 Provider 进程，但每个 Binding 获得独立 session。Day 1 不做每请求进程、自动横向扩容、
Provider worker pool 或负载均衡。`ocd` 对同时 active Provider 数设置 operator 配置的硬上限。

正式 open-compute release 仍只有一个 `ocd` executable；用户安装的 Extension Package 是 instance data，不是 open-compute release
artifact。生产启动保持离线，不自动下载 Provider。

底层进程 ownership、全局 permit/inventory 与 shutdown 协调遵守
[P17](../p17-host-process-infrastructure.md)；Provider readiness、session、Cap'n Proto control/data plane 和 restart policy 仍由 W3
`ProviderManager` 独立拥有。

## 5. Extension Package 合同

一个包至少包含：

```text
com.example.xpc-extension/
├── extension.toml
├── protocol/
│   └── xpc-api.capnp
├── worker/
│   ├── index.js
│   └── types.d.ts
├── native/
│   ├── darwin-arm64/xpc-provider
│   └── darwin-x64/xpc-provider
└── checksums.json
```

示意 manifest：

```toml
schema_version = 1
id = "com.example.xpc"
version = "1.0.0"
host_abi_version = 1

[worker]
main = "worker/index.js"
entrypoint = "XpcExtension"

[protocol]
schema = "protocol/xpc-api.capnp"
schema_sha256 = "..."

[native.darwin_arm64]
executable = "native/darwin-arm64/xpc-provider"
sha256 = "..."

[native.darwin_x64]
executable = "native/darwin-x64/xpc-provider"
sha256 = "..."

[requested_capabilities]
mach_services = ["com.example.helper"]
```

Day 1 manifest 不接受：

- 任意 executable arguments、shell command 或 PATH lookup；
- 网络下载 URL、自动更新 channel 或 post-install script；
- Provider 自选 listener、workerd endpoint、SQLite path 或内部 token；
- `ocd`/workerd environment inheritance；
- 未声明平台 binary 的 fallback；
- tenant 在 Worker upload 中追加或放宽 requested capabilities。

安装命令必须使用显式本地 package path。`ocd` 验证普通文件、无 symlink/path escape、manifest/schema、目标平台、所有 digest、
module limits 和 executable identity，再原子发布到 instance-owned content-addressed extension store。已发布 Extension Version 永不原地
修改；相同 `(id, version)` 不同 digest 拒绝安装。

TypeScript 必须在上传前编译；生产 `ocd` 不运行 Bun、Node.js、TypeScript compiler 或用户 build script。

## 6. Authority、Grant 与不可变描述符

SQLite 至少拥有以下逻辑 authority；精确 migration 在实现阶段定义：

- installed package identity、manifest digest、platform artifact digest 和状态；
- immutable Extension Version 与 Worker bundle digest；
- operator-approved grant 及规范化 grant digest；
- consumer Worker 的 Extension Binding descriptor；
- Provider process lease、start identity、期望 binary digest 和最后状态；
- active/in-flight version pins。

consumer 部署时必须固定：

```text
binding name
extension id + exact version
package sha256
extension worker code sha256
entrypoint
host ABI version
business protocol schema sha256
grant sha256
capability version
```

这些字段进入 WorkerCode hash。Extension update 创建新版本；旧 consumer 不跟随 mutable active pointer。只有重新部署 consumer 才切换
依赖版本。删除扩展版本必须被 deployment 和 in-flight pin 阻止。

RuntimeSource 只投影上述不透明身份，不返回 Provider path、argv、宿主目录、Mach endpoint、内部 fd 或 grant 私有内容。`ocd` 在打开
session 时根据 binding ID、loader key 和 descriptor digest 回查 authority，不能相信 workerd 回传的 scope。

## 7. 调用链与协议

### 7.1 Consumer Worker 到 Extension Worker

consumer 获得的是指向精确 Extension Version/entrypoint 的原生 RPC stub：

```ts
const result = await env.XPC.lookup("item");
```

Extension Binding 复用现有 Service RPC 的值、stream、callback、deadline 与 disposal 语义，但目标解析按不可变 Extension Version，
不使用普通 Service Binding 的“每次调用解析目标 Worker 当前 active deployment”行为。Extension Worker 使用自己的 env、limits 和
secret scope；它不继承 caller 的绑定或凭据。

### 7.2 Extension Worker 到 HostExtensionPort

Extension Worker 的用户 bundle 把公开方法转换为扩展协议：

```ts
export class XpcExtension extends WorkerEntrypoint {
  async lookup(id: string): Promise<Result> {
    const request = encodeLookup({ id });
    const response = await this.env.HOST.call(1, request);
    return decodeLookup(response);
  }
}
```

`HOST` 是平台注入的私有 `HostExtensionPort`。平台不理解 `lookup`、文件系统或 XPC 的业务对象；用户 bundle 与 Provider 共享被
manifest digest 固定的 codec/schema。

### 7.3 workerd 到 ocd：Broker 控制面

`ocd` 启动 workerd 时创建 generation-scoped Unix socketpair，在现有 control-fd 之外映射固定 Host Extension fd。fd 的持有本身
就是 process capability；不把 token 放入 argv、环境、日志或 RuntimeSnapshot。

workerd fork 通过该 fd 建立支持 descriptor transfer 的 Cap'n Proto `TwoPartyVatNetwork`。这条长期连接只承载 Broker 控制面：

- acquire/open session；
- session endpoint capability/FD handoff；
- revoke/close、Provider generation 变化与稳定错误；
- bounded queue、disconnect 与 generation fencing。

Cap'n Proto C++ 支持 capability server 通过 `getFd()` 暴露 Unix descriptor，client 通过 `getFd()` 取得指向同一 underlying file
description 的 FD；`TwoPartyVatNetwork` 使用 `AsyncCapabilityStream` 和非零 `maxFdsPerMessage` 启用该能力：
<https://github.com/capnproto/capnproto/blob/master/c%2B%2B/src/capnp/capability.h>、
<https://github.com/capnproto/capnproto/blob/master/c%2B%2B/src/capnp/rpc-twoparty.h>。

实现必须针对正式 workerd pin 资格化该 API，不能只因 upstream `master` 包含它就宣称当前 fork 可用。workerd 对来自 `ocd` 的每条控制
消息最多接收一个 FD；`ocd` 不接收 workerd 发送的 FD。workerd generation 退出会关闭控制连接和全部 direct session；旧 generation
的 capability 不可复用。

该 upstream 证据只证明 C++ 能力。`ocd` 的 Rust RPC stack 和用户 Provider SDK 是否支持相同的 ancillary-FD contract 必须由 W3 G0
实测；不允许假设所有 Cap'n Proto language implementation 自动支持 `getFd()`。缺失时在 open-compute 拥有的窄 transport/SDK 中实现
相同的 bounded `SCM_RIGHTS` handoff，不 fallback 到 HTTP，也不把未验证 FD 整数塞进普通 Cap'n Proto `Data`。

### 7.4 Broker 控制面 + Provider 直连数据面

每个 Provider 进程获得一条长期 Cap'n Proto control socket、bounded stdout/stderr 和明确批准的资源。`ocd` 是 session authority 与
control-plane Broker，但不代理 steady-state 业务 payload。每次创建长期 Binding session：

1. workerd 在固定 Broker control channel 上提交 opaque binding identity、loader key 与 descriptor digest；
2. `ocd` 回查 SQLite/immutable descriptor，校验 package、grant、Provider generation、capacity 和 account scope；
3. `ocd` 创建新的 Unix `socketpair()`，两个端点都不是 tenant 可见对象；
4. `ocd` 通过 Provider control channel 把端点 A 作为 fd-backed capability 交给目标 Provider，并附带已经收窄的 session descriptor；
5. Provider 在端点 A 上启动绑定该 descriptor/grant 的 `DirectProviderSession` Cap'n Proto server，handshake 成功后 ACK；
6. `ocd` 通过 Broker control channel 把端点 B 作为 fd-backed capability 返回给 workerd；
7. workerd 调用 `getFd()`，在端点 B 上建立 session-scoped `TwoPartyClient`，`HostExtensionPort` 此后直接调用 Provider；
8. `ocd` 关闭自己的数据端点副本，只保留 session authority、control capability 和 lifecycle record。

```text
session setup:  workerd ──Cap'n Proto──> ocd Broker ──Cap'n Proto──> Provider
data path:      workerd <──────── session-scoped Cap'n Proto ────────> Provider
```

这样避免每个 unary/stream 在 `ocd` 中二次排队、解析和复制，同时 `ocd` 仍决定谁可以取得哪一个 endpoint。首版一个长期 Binding
session 使用一个 socketpair；不增加共享 Provider data connection、session bearer token 或自动 connection pool。只有 FD 压力被正式
测量为瓶颈时才重新设计复用。

正常 dispose 时 workerd 关闭 data endpoint，Provider 以 disconnect 释放 session；operator revoke 或 descriptor 失效时，`ocd` 同时
通知 workerd drop endpoint，并通过 Provider control channel 请求关闭 session。Provider 在 deadline 内不确认时，`ocd` 终止该
Provider process group，使其全部 direct endpoint 由内核关闭；不保留一个假装能远程关闭其他进程 FD 的 Broker duplicate。

Provider 不得向 `ocd` 或 workerd 提供任意 FD。所有 direct session socketpair 均由 `ocd` 创建：`ocd -> Provider` 方向每条消息最多
一个 FD，`Provider -> ocd` 的 `maxFdsPerMessage = 0`。Cap'n Proto 文档明确要求保持该上限很低以避免耗尽 FD table，并列出
supervisor-to-sandbox 单向传递作为典型场景。

普通 Cap'n Proto capability 经 Broker 转发不等于自动三方直连；Level 3 three-way introduction 仍列在 upstream roadmap：
<https://capnproto.org/roadmap.html>。W3 的直连来自显式 fd-backed session capability，不依赖未实现的自动 introduction。

### 7.5 两层 schema

平台和用户 schema 必须分层，不能把用户业务接口编译进 `ocd` 或 workerd。

**第一层：平台固定 Host ABI。** 由 open-compute 版本化并随 `ocd`/workerd 发布，至少定义：

- `HostExtensionBroker`：acquire/open、fd-backed session endpoint、revoke/close；
- `ProviderControl`：handshake、attach/revoke session、health/readiness；
- `DirectProviderSession`：稳定 numeric method ID、bounded opaque `Data`、deadline/cancellation、byte stream、abort 与 dispose；
- host/provider ABI version、extension/package/business-schema digest、descriptor/grant digest 与 generation identity。

Host ABI schema 的字段和 method ordinal 按正式 pin 更新；未知 ABI/ordinal 必须明确失败，不做协议猜测。

**第二层：用户扩展业务 schema。** Extension Package 自带并以 digest 固定，例如 `xpc-api.capnp`。它定义 `lookup`、`readFile` 等
业务 request/result、method registry 和错误值，由 Extension Worker 与 Provider 各自编译/使用。平台 `DirectProviderSession` 只看到
numeric method ID 和 opaque `Data`，不解释业务字段，也不把用户 `.capnp` 编译进平台 binary。

业务 payload 默认使用 package 中的 Cap'n Proto schema，不使用 JSON。workerd 的 `HostExtensionPort` 在 direct channel 边界执行 frame、
method number、并发、总字节、deadline 和 stream backpressure 限制；Provider 再验证业务 schema。Broker 不读取或转发 steady-state payload。

## 8. workerd fork 边界

fork 只新增通用机制：

1. 私有 `HostExtensionFactory` JSG binding，仅 loader host 可见；
2. `HostExtensionFactory.open(binding identity)` 返回 `HostExtensionPort`；
3. `HostExtensionPort.call()`、stream 和 dispose 的 JSG API；
4. 固定 Broker control fd 的 `AsyncCapabilityStream`/`TwoPartyVatNetwork` 接线与每消息一个 FD 的接收上限；
5. 从 fd-backed session capability 取得 FD，并为每个 session 建立/销毁 direct `TwoPartyClient`；
6. WorkerLoader dynamic env 对该 capability 的受约束委派；
7. IoContext、GC、abort、isolate eviction、Provider disconnect 和 generation exit 的引用生命周期；
8. tenant 无法构造 Factory、改变 extension/provider identity 或取得底层 channel/raw FD。

不为每个扩展修改 workerd `Binding` union，不把用户 schema 编译进 fork，也不暴露任意 `JsRpcTarget`、Loader、ServiceDesignator、
raw fd 或 Cap'n Proto capability 给 tenant。fork 变更必须按[正式工作流](README.md)独立提交并协调更新四平台 binary pin；开发 binary
不能绕过 formal lock。

## 9. ocd Provider Manager

Provider Manager 是 `ocd` composition concern，使用一个按 Provider key 索引的有界 registry。每个 Provider supervisor 状态只表达：

```text
installed -> starting -> ready -> backoff/failed -> stopping -> stopped
```

Day 1 生命周期：

1. 第一次有效 session acquire 合并并发启动，只创建一个进程；
2. 启动使用 package 中经过 digest 校验的绝对 executable，不搜索 PATH；
3. `env_clear()`，0700 私有工作目录，独立 process group，只映射明确 fd；
4. 建立长期 Provider control channel，handshake/readiness 必须在有界 deadline 内匹配 ABI、package 和 schema digest；
5. ready 后多个 Binding session 可以复用进程，但每个 session 使用 `ocd` 创建的独立 direct socketpair，grant、limits 和 identity 相互隔离；
6. Provider crash 使该进程的全部 session 立即失效；在途调用返回稳定错误，绝不自动重放；
7. 有 deployment pin 时按 bounded exponential backoff 重启；达到失败阈值后 provider degraded，其他 Provider 和普通 Worker 继续服务；
8. Extension Version 无 deployment/in-flight pin 后停止 Provider；首版不增加 idle timeout 或自动缩容；
9. `ocd` shutdown 先停止 acquire、drain 有界时间，再 TERM、KILL、reap 完整 process group；
10. restart 时只认领 SQLite lease 中同时匹配 start identity、binary digest、package digest 和 process identity 的 orphan；未知进程不 signal。

Provider 不应塞进 `WorkerdSupervisor`。它复用[P17](../p17-host-process-infrastructure.md)的 Host Process Runtime、permit、inventory 与
shutdown 协调，但保持独立的 readiness、control channel、direct session 与 restart 状态机。

## 10. 安装、绑定、装载与升级

### 10.1 安装

1. operator 提交本地 package；
2. `ocd` 校验并原子发布 immutable package；
3. operator 查看 requested capabilities，并显式创建 grant；
4. 缺少当前平台 binary、ABI 不支持、digest mismatch 或 grant 不完整时 fail closed，Provider 尚不执行。

### 10.2 部署 consumer

1. 上传边界解析 extension ID、精确 version 和 entrypoint；
2. 验证 package ready、grant 有效、account scope 与 env name；
3. 写入 immutable Extension Binding descriptor 和 WorkerCode hash；
4. 不因为上传而启动 Provider，也不在 SQLite transaction 中做进程或文件 I/O。

### 10.3 首次调用

1. RuntimeSource 返回已校验 extension descriptor；
2. WorkerLoader 装载精确 Extension Worker bundle；
3. `HostExtensionFactory` 向 `ocd` acquire session；
4. `ocd` 重验 authority，必要时启动 Provider，创建 socketpair 并先把端点 A attach 到已收窄 Provider session；
5. Provider ACK 后，`ocd` 把端点 B 的 fd-backed capability 返回给 workerd；
6. workerd 建立 direct `TwoPartyClient` 并把 `HOST` 注入 Extension Worker；consumer 只得到 Extension Worker RPC stub；
7. Extension Worker 方法通过 `HOST` 直连 Provider，`ocd` 不转发业务 payload。

### 10.4 升级和删除

新 package 创建新 Extension Version 和 Provider key。新旧版本可以在 rollout/drain 时并存；旧版本不会被原地替换。删除遵守
deployment/in-flight pin，先拒绝新绑定，待引用归零后停止 Provider 并删除可恢复 package data。扩展 package 的物理删除属于显式
operator 操作，不能作为普通 cache GC。

## 11. 文件系统扩展示例

用户可以提供：

```text
consumer env.FILES
  -> FileSystemExtension WorkerEntrypoint
  -> env.HOST
  -> fs-provider child
  -> openat/read/write/list
```

公开 API 可以是用户自己定义的 `readText()`、`writeJson()`、`list()`，平台不固定 Node `fs` 兼容层。Provider 必须将用户路径视为
不可信输入，并按 operator grant 限制根目录、读写权限、单文件大小、总流量和并发。

Day 1 Native Provider 属于 operator-trusted code：manifest/grant 约束 Worker 能请求什么，不构成对恶意 Provider 的 OS sandbox。
如果正式文件系统 Provider 需要平台可验证的目录 containment，`ocd` 应打开根目录并通过受控 descriptor handoff 授予 Provider，或使用
独立 OS identity/sandbox；不能只把绝对路径和“请勿越界”配置当成安全边界。该 fd handoff 与各正式目标的 race/symlink 回归必须在
宣布强 containment 前完成。

## 12. macOS XPC 扩展示例

用户可以提供签名的 Swift/Objective-C/Rust Provider：

```text
consumer env.XPC
  -> XpcExtension WorkerEntrypoint
  -> HostExtensionPort
  -> direct Cap'n Proto session
  -> signed xpc-provider child（session 由 ocd Broker 授权/建立）
  -> NSXPCConnection / XPCSession
  -> launchd-managed target service
```

Apple 把 XPC Service、LaunchAgent 和 LaunchDaemon 定义为不同的 launchd 管理模式，`NSXPCConnection`/XPC session 负责进程间连接：
<https://developer.apple.com/documentation/xpc>、<https://developer.apple.com/documentation/foundation/nsxpcconnection>。

`ocd` 可以监督 XPC client Provider，但不能授予它没有的 macOS 权限：

- entitlement 和 code-signing identity 属于 Provider binary；
- Mach service 必须在 Provider 可见的 bootstrap namespace 中注册；
- target service 可以检查 audit token、Team ID、签名或 entitlement；
- LaunchAgent/LaunchDaemon/XPC Service 的安装仍必须满足 macOS/launchd 合同；
- requested `mach_services` 只是 operator 审批输入，不承诺绕过系统权限。

未签名、签名不匹配、服务不可见、entitlement 缺失或 target 拒绝时返回稳定 provider-unavailable/permission-denied，不 fallback 到
其他 XPC service 或 shell helper。

## 13. 信任与安全边界

### 13.1 Day 1 信任声明

Native Provider 具有其 OS 进程身份能够取得的宿主权限。进程边界防止普通内存破坏直接污染 `ocd`/workerd，但 `env_clear()`、manifest
和 RPC grant 不能阻止恶意 Provider 读取同一 OS 用户可访问的文件或连接可见服务。

因此 Day 1 只支持 operator 显式安装并信任的 native Provider。普通 account/tenant 只能部署 Extension Worker 或绑定 operator 已安装、
已授权的 Extension Version。若未来允许不受信 tenant 上传 native binary，必须先增加并资格化独立 UID、namespace/seccomp、macOS
sandbox/VM 或同等级别的 OS 隔离；不能把当前机制描述为安全的多租户 native sandbox。

### 13.2 必须保持的隔离

- Provider 永不获得 SQLite handle、master key、S3 credentials、RuntimeSource、control API 或 workerd internal token；
- consumer 不获得 `HOST`、Provider channel、grant 私有内容、binary path 或宿主拓扑；
- Extension Worker 不继承 consumer env、secret 或 binding；
- Provider stdout/stderr 有界且默认只记录 digest/分类，不进入 tenant response；
- Provider exception、XPC object description、路径、argv、schema payload 和原始 stderr 必须脱敏；
- Provider 不能监听公开地址；私有 socket 放在 instance-owned 0700 目录并验证 owner/mode/symlink/peer identity；
- 只有 `ocd` 能创建和分发 direct session socketpair；workerd/Provider 到 `ocd` 的控制方向不接受 FD；
- tenant、Extension Worker 与 consumer 永不取得 raw FD；XPC/Mach handle、目录 FD 等宿主资源只进入 Provider，不通过 direct session
  暴露给 workerd；
- package 安装、grant、升级、停止和删除是 operator 权限，不由 Worker 调用触发；
- capability version、ABI、schema 或 package digest 不匹配一律 fail closed，不做旧版 fallback 或协议猜测。

## 14. Limits、错误与可观察性

平台 limits 至少包括：

- installed package 大小、module 数和 native binary 大小；
- 每 account/instance 的 Extension Version 与 active Provider 数；
- 每 Provider session、并发 call、排队、unary frame 和 stream byte 上限；
- call deadline、startup/readiness deadline、drain deadline；
- Provider CPU、地址空间/RSS（按目标可执行能力明确）、打开 fd、stdout/stderr；
- Broker/Provider 每消息 FD、instance/session FD 总数和 direct-channel queue/backpressure；
- restart backoff、连续失败阈值和 retained failure evidence 大小。

稳定错误至少区分：

```text
EXTENSION_NOT_INSTALLED
EXTENSION_VERSION_UNAVAILABLE
EXTENSION_PLATFORM_UNSUPPORTED
EXTENSION_GRANT_DENIED
EXTENSION_ABI_MISMATCH
EXTENSION_PROTOCOL_MISMATCH
EXTENSION_PROVIDER_UNAVAILABLE
EXTENSION_PROVIDER_CRASHED
EXTENSION_CALL_TIMEOUT
EXTENSION_CALL_CANCELLED
EXTENSION_PAYLOAD_TOO_LARGE
EXTENSION_OVERLOADED
EXTENSION_METHOD_UNSUPPORTED
```

不得自动重放已发送给 Provider 的调用；是否幂等由扩展 API 自己定义。metrics 使用 extension ID/version、结果类、延迟、byte bucket、active
session 和 restart count，不记录 payload、路径、Mach service 参数或 secret。health 把单个 Provider degraded 与 workerd/platform readiness
分开；一个扩展失败不能使不依赖它的 Worker 全局 unavailable。

## 15. 非目标

Day 1 不实现：

- 在线 marketplace、远程下载、自动更新或第三方信任根；
- tenant-untrusted native code sandbox；
- `dlopen()`、Rust/C++动态 ABI 或 Node native addon；
- arbitrary command、shell、PATH executable 或 Provider 自定义 argv/env；
- Provider 公网服务发现、集群调度、跨机器 RPC 或多区域 placement；
- 将现有 KV/R2/D1/DO 全部迁移到 Host Extension ABI；
- Provider 自动扩容、per-request process、idle timeout 或热替换同一版本；
- 声称任意 macOS XPC entitlement、受保护系统服务或 root daemon 可用。

现有 Cloudflare-compatible Binding 保持其当前 workerd/subrequest/Service RPC 路径。W3 只服务没有标准 Cloudflare Binding、且必须访问
本机能力的 operator extension。

## 16. 实施所有权与顺序

按一个完整纵向切片实施，不保留第二套协议或占位 registry：

1. **Authority/package**：Extension Package 验证、immutable version、grant、binding descriptor、pins 与 operator API/CLI；
2. **Process substrate**：先实现[P17](../p17-host-process-infrastructure.md)的通用 owner/permit/inventory，并迁移 Xberg 证明短命路径；
3. **Provider lifecycle/control**：content-addressed executable、Provider Manager、control socket、handshake、limits、crash/backoff、shutdown/orphan；
4. **direct data plane**：Broker 授权、per-session socketpair、fd-backed capability、Provider attach/ACK、revoke 与 FD limits；
5. **workerd bridge**：`HostExtensionFactory`、`HostExtensionPort`、Broker control fd、direct `TwoPartyClient`、Loader 委派、GC/abort/eviction；
6. **Extension Worker target**：精确版本装载、原生 Service RPC stub、独立 env/limits；
7. **reference extension**：一个文件系统 provider + facade 证明用户 package、两层 schema、unary/stream、权限、重启和升级全链路；
8. **macOS qualification**：独立 XPC Provider 证明签名 binary、Mach service、拒绝、interrupt、restart 和系统权限边界。

Rust ownership 遵守现有 crate 方向：storage 持久化 authority；workers 拥有 immutable descriptor/runtime snapshot；runtime 拥有 workerd binary
与 supervisor 低层原语；service 组合 package、grant、Provider Manager 和私有 Broker。TypeScript facade/loader 在 `packages/runtime/`；workerd
JSG/Cap'n Proto 修改只在 `third_party/workerd/`。

## 17. 验收

完成声明至少需要：

- 未安装、digest mismatch、unknown ABI/schema/platform、缺 grant 和权限扩大全部 fail closed；
- 两个 consumer 共享一个 Provider process但 session/grant 不串；
- 精确 Extension Version 不随另一个 active version 改变；
- consumer 无法取得 `HOST`、Factory、Provider 路径、grant 或内部 channel；
- 正式 pinned workerd 证明 Cap'n Proto FD handoff 可用，方向性 `maxFdsPerMessage`、FD overflow/截断和 capability lifetime fail closed；
- steady-state unary/双向 stream 只经过 workerd-to-Provider direct channel，backpressure、abort、deadline 和 payload limits 通过；
- Host ABI 与用户 business schema digest/ordinal 独立校验，任一 mismatch 不建立 session；
- Provider crash 不自动重放调用，旧 session fenced，新进程 readiness 后新 session 恢复；
- workerd restart、`ocd` restart、extension upgrade、drain 和删除不泄漏进程、fd、socket、临时目录或 pin；
- malicious path/schema/frame/stderr 不泄漏宿主路径、payload、secret 或拓扑；
- active Provider 上限和单 Provider overload 不影响普通 Worker及其他 Provider；
- 文件系统 reference extension 覆盖 traversal、symlink/race、读写权限、大文件 stream 和崩溃恢复；
- macOS XPC qualification 覆盖签名/entitlement 不足、unknown service、interrupt/invalidate、Provider restart 和真实成功调用；
- 正式 fork commit、四平台 workerd archive/digest、compatibility date/flags、single-binary offline startup 和完整产品 Gate 协调更新。

文档阶段只运行文档检查；实现涉及安全、协议、持久化、process lifecycle 和 workerd fork，最终必须按仓库规则完成对应 focused coverage、
真实 runtime Gate 和一次完整 workspace Gate。

返回[workerd 路线](README.md)与[文档索引](../README.md)。

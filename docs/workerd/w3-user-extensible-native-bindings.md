# W3：用户可扩展原生 Binding 与 Provider 子进程

状态：**planned（2026-09-18）**。本文确定 Day 1 的静态配置、隔离与生命周期合同；Host ABI 与跨语言 FD transport
须先完成 §16 的 W3 G0 再冻结，实现、正式 workerd fork pin 和产品 Gate 尚未完成。macOS XPC 只作为平台特定示例与后续
可选资格项，不阻塞 W3 完成。

## 1. 用户结果与结论

open-compute 允许 operator 仅在 `ocd` config file 中静态声明本地扩展包及其授权，并让普通 Worker 以 Binding 风格调用：

```ts
const value = await env.MY_EXTENSION.lookup("key");
```

扩展可以由用户实现文件系统、本地数据库、设备 SDK 或 macOS XPC 等宿主能力，调用链不使用 HTTP。Day 1 固定为：

1. 用户扩展包同时包含一个 **Extension Worker** 和一个或多个目标平台的 **Native Provider** executable；
2. Extension Worker 用 `WorkerEntrypoint` 暴露用户定义的 JavaScript RPC API；
3. Native Provider 运行在独立子进程中，调用文件系统、XPC 或其他宿主 API；
4. workerd fork 只新增一个通用、私有的 `HostExtensionPort` JSG capability，不内置每种扩展的业务接口；
5. `ocd` 启动时校验静态扩展配置与本地包，按需启动、监督和回收 Provider，并作为 Cap'n Proto Broker 建立和撤销 session；
6. consumer Worker 到 Extension Worker 使用 workerd 原生 RPC；`ocd` 完成控制面授权后，Extension Worker 通过 workerd 与 Provider
   的 session-scoped Cap'n Proto 直连数据面调用；
7. Native Provider 是 **operator-configured / operator-trusted code**，不是任意 tenant 可上传的 native code；
8. 不把用户动态库 `dlopen()` 到 `ocd` 或 workerd，不给 Provider 公网或控制面 listener，也不自动从网络下载扩展。

扩展仍是无需重新编译平台的外部模块，但不是运行中可安装的插件。新增、升级、移除及 grant 变更只通过修改 `ocd` config file
并重启 `ocd` 生效；Day 1 不提供扩展安装/授权管理 API、CLI、控制台写入口或热加载。平台只内置固定 ABI、生命周期和授权边界，
不随每个用户扩展重新发布 `ocd` 或 workerd。普通 Worker 的部署只引用已配置且获准使用的扩展，不得注册或改写扩展。

## 2. 术语与所有权

| 名称                   | 含义                                                                                           | 所有者                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Extension Package      | manifest、Extension Worker bundle、Provider binaries、类型、协议 schema 和 digest 的不可变集合 | operator 静态配置，`ocd` 校验与快照                  |
| Extension Version      | 一个 package digest 对应的不可变版本                                                           | config 声明；SQLite 持久化已验证身份                 |
| Extension Worker       | 用户提供的 Worker 模块，以 `WorkerEntrypoint` 暴露 RPC 方法                                    | workerd isolate                                      |
| Native Provider        | 用户提供的目标平台 executable，执行宿主调用                                                    | `ocd` 子进程 supervisor                              |
| HostExtensionPort      | Extension Worker 可见的私有 JSG transport；只提供二进制 unary/stream 调用和 dispose            | workerd fork                                         |
| Provider Session       | 已绑定一个 extension binding、descriptor digest 与 grant 的 Cap'n Proto capability             | `ocd` 授权，Provider 执行                            |
| Direct Session Channel | `ocd` 创建并通过 fd-backed capability 分发的 workerd-to-Provider Unix socketpair               | `ocd` 建立和 fence，端点分别由 workerd/Provider 持有 |
| Extension Binding      | consumer Worker 环境中的 RPC stub，指向精确 Extension Version/entrypoint                       | Worker immutable descriptor                          |
| Grant                  | operator 为精确扩展版本声明的 account scope、宿主权限及规范化 digest                          | 仅来自 `ocd` config；SQLite 保存投影与引用           |

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
- [P17 宿主子进程管理基础设施](../implemented/p17-host-process-infrastructure.md)已共享 verified-exec、process-group 与 signal/reap
  原语；Xberg 短任务 owner 与常驻 workerd owner 仍是不同路径。通用常驻 child API 尚未交付，lease/readiness/generation restart
  仍由 `WorkerdSupervisor` 拥有；不能把它们描述为 Provider 已可直接调用的统一 owner。
- W3 按 §9 从现有常驻 owner 提取最小受控接口；若 P18 已完成同一提取则直接复用，不复制第三套生命周期，也不使用 Xberg
  的一次性任务状态机运行长期 Provider。

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

同一精确版本被多个 Worker 绑定时共享一个 Provider 进程，但每个 Binding 获得独立 session。必须区分三个共享范围：

| 对象 | 共享/隔离粒度 |
| --- | --- |
| Package 与只读 code bundle | 按 package digest 共享不可变字节 |
| Provider process | 按上述 Provider key 共享进程；业务状态仍必须按 session/grant 隔离 |
| 带 `HOST` 的 Extension Worker 实例 | 按 consumer immutable loader key、binding ID、descriptor digest 隔离 |

Extension Worker 的平台生成 runtime key 固定使用独立 namespace，例如：

```text
extension/<consumer_loader_key>/<binding_id>/<descriptor_sha256>
```

descriptor 已覆盖精确 package、code、entrypoint 和 grant。key 只取自已验证 authority，缓存限定在当前 workerd generation；
不能直接复用普通 Service Binding 按目标版本/entrypoint 共享实例的 key。不同 consumer，或同一 consumer 的两个 Binding，即使
引用相同版本和相同 grant，也不共享带 `HOST` 的实例与模块级可变状态。原生 RPC transport 可以复用，注入权限的实例不能合并。

Day 1 不做每请求进程、自动横向扩容、Provider worker pool 或负载均衡。`ocd` 对同时 active Provider 数设置 operator 配置的硬上限。

正式 open-compute release 仍只有一个 `ocd` executable；用户配置的 Extension Package 是 instance data，不是 open-compute release
artifact。生产启动保持离线，不自动下载 Provider。

底层进程 ownership 与 shutdown/reap primitives 遵守
[P17](../implemented/p17-host-process-infrastructure.md)；Provider readiness、session、capacity、Cap'n Proto control/data plane 和 restart policy 仍由 W3
`ProviderManager` 独立拥有。

## 5. Extension Package 与静态配置合同

### 5.1 包内容与校验

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

`ocd` 只从主配置显式声明的本地 package path 读取包，不扫描目录自动注册。启动校验普通文件、无 symlink/path escape、
manifest/schema、目标平台、所有 digest、module limits 和 executable identity，再原子快照到 instance-owned content-addressed
extension store。快照与可执行内容必须来自同一组已验证文件，不能在校验后重新跟随可变路径读取未经校验的内容。已发布
Extension Version 永不原地修改；相同 `(id, version)` 不同 digest 拒绝，不能通过移除配置再添加绕过身份记录。

TypeScript 必须在打包前编译；生产 `ocd` 不运行 Bun、Node.js、TypeScript compiler 或用户 build script。

### 5.2 唯一配置入口：ocd config file

Day 1 使用主配置中的 `[[extensions]]` 静态声明；以下为 planned 配置示例，摘要与 account ID 占位值必须替换为真实值，
不表示当前 `ocd` 已实现这些字段。XPC 包仅适用于其声明的平台，正式跨平台 fixture 仍使用 §11 的只读文件系统包。

```toml
[[extensions]]
id = "com.example.xpc"
version = "1.0.0"
package_path = "./extensions/com.example.xpc/1.0.0"
package_sha256 = "..."

[[extensions.grants]]
name = "app-xpc"
account_id = "..."

[extensions.grants.capabilities]
mach_services = ["com.example.helper"]
```

`package_path` 相对于实际加载的 `ocd` config file 所在目录解析，也可以是显式绝对路径；不得相对于进程 cwd、package 内的
manifest 或数据目录隐式猜测，不展开 shell、环境变量或网络 URL。平台生成的包快照、Provider 工作目录和 lease/recovery 数据
全部位于既有 instance data directory，不引入第二个数据目录。`extension.toml` 只描述包内容与权限请求，不能自行启用扩展或授权。

同一 `(id, version)` 只允许一条声明，配置与 manifest 的 id/version/digest 必须一致。一个版本可包含多个具名 grant，grant name
在该版本内唯一；每个 grant 显式限制 account，缺失 scope、重复名称、未知 capability 或超过 manifest 请求范围的授权均拒绝。
未配置 grant 不等于自动批准全部请求。grant 中的宿主文件路径同样按 config 所在目录解析并规范化，再参与 grant digest；
不得从 Provider cwd 隐式补全。consumer 部署可选择获准使用的 grant name，但名字本身不是授权，仍须校验部署者权限与
consumer account；tenant 不能提交 capabilities、宿主路径、package path 或自选 Provider。

本进程使用启动时完整校验的配置快照；磁盘文件改变不会影响现有 session。所有扩展配置和 grant 变更都需要重启 `ocd`，
不提供 file watcher、SIGHUP 热加载、环境变量/CLI 扩展覆盖、管理 API 或控制台写入口。只读诊断可显示已配置状态与稳定错误，
不得借诊断或 Worker upload 注册、安装、更新、授权或删除扩展。显式配置错误使启动校验失败，不沿用 SQLite 中的旧配置兜底。

## 6. Authority、Grant 与不可变描述符

扩展声明和 grant 的唯一配置来源是 `ocd` config file。SQLite 持久化已验证的身份、配置投影和部署引用，不拥有可以独立增删扩展
或放宽 grant 的第二套管理接口。每次启动都从当前配置完整校验并对齐投影；数据库里仍有 package/grant 记录，不代表当前获准使用。
精确 migration 在实现阶段定义，已发布 migration 不修改。

SQLite 至少记录：

- 已验证 package identity、manifest/platform artifact digest、immutable Extension Version 与 Worker bundle digest；
- 当前配置投影及规范化 grant（含名称、account scope、capabilities）与 digest，以及供旧 descriptor 核验的历史身份；
- consumer Worker 的 immutable Extension Binding descriptor 与持久化 deployment reference；
- Provider lease、start identity、binary/package digest 与恢复证据；
- 执行引用所需的 generation-fenced 记录；opening/session registry 仍是 Broker 拥有的有界运行态，不让 SQLite 代理 payload。

consumer 部署时必须固定：

```text
binding name + binding ID
extension id + exact version
package sha256
extension worker code sha256
entrypoint
host ABI version
business protocol schema sha256
grant name + grant sha256
capability version
```

字段由上传边界根据当前配置和 authority 解析并进入 WorkerCode hash。消费者不能自报可信 digest 或 scope。Extension update
创建新版本；旧 consumer 不跟随 mutable active pointer。grant 的权限或 scope 变化也产生新 digest，不改写旧 descriptor；需要
重新部署 consumer 才能切换。整份配置的启动 generation 不进入 WorkerCode hash，避免无关配置修改使既有部署被动变更。

配置授权与内容保留是两件事：移除 extension/grant 并重启后，旧 descriptor 保留但不可取得 session，不能被 deployment pin
重新授权；历史内容只有在配置引用、deployment reference 和执行引用均归零后才允许物理清理。配置撤销不得因旧部署仍在引用
而被拒绝，也不得为了撤销而删除或重写旧部署。历史引用缺少当前授权时仅该 Binding 不可用，不使无关 Worker 全局不可用。

RuntimeSource 只投影不透明身份，不返回 Provider path、argv、宿主目录、Mach endpoint、内部 fd 或 grant 私有内容。`ocd` 打开
session 时同时核对当前配置投影与 immutable descriptor，根据 binding ID、consumer loader key、descriptor digest 回查 authority，
不能相信 workerd 回传的 scope，也不能只因历史 package/grant 存在就批准 acquire。

所有 file/process I/O 都在 SQLite transaction 之外执行。启动先验证全部声明并准备不可变包，再原子提交完整配置投影；中途失败
不得发布部分授权。旧 authority generation 的清理与新 generation 的接入按 §7.6、§9 执行。

## 7. 调用链与协议

### 7.1 Consumer Worker 到 Extension Worker

consumer 获得的是指向精确 Extension Version/entrypoint 的原生 RPC stub：

```ts
const result = await env.XPC.lookup("item");
```

Extension Binding 复用现有 Service RPC 的值、stream、callback、deadline 与 disposal 语义，但目标解析按不可变 Extension Version，
不使用普通 Service Binding 的“每次调用解析目标 Worker 当前 active deployment”行为。Extension Worker 使用自己的 env、limits 和
secret scope；它不继承 caller 的绑定或凭据。只有静态配置包内、code digest 匹配的 facade 能被注入 `HOST`，实例隔离 key 遵守 §4。
普通 tenant 上传的代码即使导出同名 `WorkerEntrypoint`，也不因此获得 Factory 或 `HOST`。

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
manifest digest 固定的 codec/schema。`HOST` 保存不可变 Binding identity，并拥有当前可替换的 session 连接；它不是第一次调用
IoContext 的持久化副本。每次 call/stream 单独关联当前 IoContext、deadline、取消和在途引用，具体生命周期见 §7.7。

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
2. `ocd` 核对当前静态配置投影与 immutable descriptor，校验 package、grant、各 generation、capacity 和 account scope，并登记
   opening session 与临时 setup 引用；
3. `ocd` 创建新的 Unix `socketpair()`，两个端点都不是 tenant 可见对象；
4. `ocd` 通过 Provider control channel 把端点 A 作为 fd-backed capability 交给目标 Provider，并附带已经收窄的 session descriptor；
5. Provider 在端点 A 上启动绑定该 descriptor/grant 的 `DirectProviderSession` Cap'n Proto server，handshake 成功后 ACK；
6. Provider ACK 后，`ocd` 按 §7.6 再确认 opening session 未被 fence、授权和 generation 仍有效，再发布端点 B 的 fd-backed capability；
7. workerd 调用 `getFd()`，在端点 B 上建立 session-scoped `TwoPartyClient`，`HostExtensionPort` 此后直接调用 Provider；
8. `ocd` 关闭自己的数据端点副本，只保留 session authority、control capability 和 lifecycle record。

```text
session setup:  workerd ──Cap'n Proto──> ocd Broker ──Cap'n Proto──> Provider
data path:      workerd <──────── session-scoped Cap'n Proto ────────> Provider
```

这样避免每个 unary/stream 在 `ocd` 中二次排队、解析和复制，同时 `ocd` 仍决定谁可以取得哪一个 endpoint。首版一个长期 Binding
session 使用一个 socketpair；不增加共享 Provider data connection、session bearer token 或自动 connection pool。只有 FD 压力被正式
测量为瓶颈时才重新设计复用。

正常 dispose 时 workerd 关闭 data endpoint，Provider 以 disconnect 释放 session。配置撤销在重启边界处理；内部 revoke/close
仍用于 descriptor 失效、generation fencing 和关闭流程，不是可修改配置的管理 API。`ocd` 通知 workerd drop endpoint，并通过
Provider control channel 请求关闭 session；Provider 在 deadline 内不确认时终止其 process group，影响该 Provider 的全部 session。
Provider 不得 daemonize、让后代脱离受监督进程组或把控制/data FD 转交给未受监督进程。不能靠保留 Broker duplicate 假装远程
关闭其他进程 FD；撤销完成语义与 Broker 自身失联处理见 §7.6。

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
- host/provider ABI version、extension/package/business-schema digest、descriptor/grant digest、session identity，以及
  authority/workerd/Provider generation identity。

Host ABI schema 的字段和 method ordinal 按正式 pin 更新；未知 ABI/ordinal 必须明确失败，不做协议猜测。

**第二层：用户扩展业务 schema。** Extension Package 自带并以 digest 固定，例如 `xpc-api.capnp`。它定义 `lookup`、`readFile` 等
业务 request/result、method registry 和错误值，由 Extension Worker 与 Provider 各自编译/使用。平台 `DirectProviderSession` 只看到
numeric method ID 和 opaque `Data`，不解释业务字段，也不把用户 `.capnp` 编译进平台 binary。

业务 payload 默认使用 package 中的 Cap'n Proto schema，不使用 JSON。workerd 的 `HostExtensionPort` 在 direct channel 边界执行 frame、
method number、并发、总字节、deadline 和 stream backpressure 限制；Provider 再验证业务 schema。Broker 不读取或转发 steady-state payload。

### 7.6 Acquire、撤销与 authority 失联

Broker 在一个有界 registry 中拥有 session 的 `opening -> ready -> closing -> closed` 状态。校验成功后先登记 opening、占用
session/FD admission 和临时 setup 引用，再异步启动 Provider 或等待 attach ACK；不能等收到 ACK 才让 session 进入撤销可见范围。
ACK 后必须在同一受控状态机中重新确认 descriptor、grant 与 authority/workerd/Provider generation，才能发布 endpoint；失败、取消
或超时则关闭尚未交付的端点，并有界地撤销已 attach 的 Provider 端点，完成后释放 setup 引用。不得在 SQLite transaction 或持锁
临界区内阻塞执行 I/O。

revoke 与 acquire 的发布在同一 owner 中串行化，覆盖 opening、已交付和交付中的 endpoint。先 fence 新调用与新交付，再通知两端；
已收到 revoke/generation fence 的 endpoint 即使晚到，也不能被 workerd 激活。只有两端已确认停止该 session、关闭端点并结束
相关执行，或未响应的一端已经由 supervisor 确认终止后，才能记录撤销完成和释放执行引用。正常 drain 可以先等待已有调用，
安全撤销则立即拒绝新调用并取消在途工作；取消不代表已经发生的宿主副作用被回滚。

`ocd` 不是数据面代理，因此其退出本身不保证 workerd-to-Provider socketpair 关闭。控制面失联必须 fail closed：

- workerd 的 Broker control disconnect：fence 该 authority generation 的全部 `HOST`，拒绝新调用/重连、关闭 direct endpoint，
  在途调用失败；不允许直连数据面在失去 Broker 后继续服务。
- Provider 的 `ocd` control disconnect：停止接受新业务调用，关闭全部 session，并在有界取消/清理后退出；无法取消的宿主操作
  按调用失败且结果未知处理，不能把 disconnect 当成操作已回滚。
- workerd 或 Provider generation 退出：旧 session/capability 永不复用。Provider 单独重启时，新调用按 §7.7 重新 acquire；
  authority 退出则整代失效，新 `ocd` 不接管旧控制连接或旧 session。

这里依赖 operator-trusted Provider 遵守 SDK 的关闭合同，不宣称能隔离或撤销恶意同 UID 进程的全部宿主权限。下一次启动必须
先按 lease 校验、清理旧 orphan 并确认退出，再允许对应 replacement generation 接入，不能以恢复服务为由跳过身份校验。

### 7.7 HostExtensionPort、调用与 pin 生命周期

`HostExtensionPort` 是 Binding-scoped 的连接 owner，状态为 `disconnected -> acquiring -> ready`，另有终态 `closed/fenced`。
底层 session channel 的所有权不绑定第一次调用的 IoContext；每个 call/stream 单独持有本次执行上下文和预算。

Provider crash/disconnect 使当前连接转为 disconnected，旧在途调用与 stream 返回稳定错误，不重放已发送或无法证明未发送的调用。
之后独立发起的新调用可在 Provider ready 后合并并发 acquire，经 Broker 重验当前授权，建立新 generation 的 session；不要求
重启 workerd、重新部署 consumer 或先驱逐其已缓存的 Extension Worker。acquire 受 deadline/capacity/backoff 限制，不无限排队
或紧循环重试。旧 stream 和依赖旧 Provider generation 的对象状态不能被静默接到新 session。

grant 撤销、descriptor 失效、显式 dispose、isolate eviction 或 authority/workerd generation fence 使对应 Port 进入终态，不能自动
重新打开。仍获授权的同一部署在 eviction 后重新装载时，可经 Factory 重验后创建新 Port，不要求重新部署；这不允许被撤销的
identity 通过缓存重建恢复权限。新部署或新 authority generation 也必须创建新 Port，不能复用终态对象。单次调用 timeout/abort
只取消该调用，不关闭同一 session 的其他正常调用；遇到 channel/protocol 故障才使整个连接失效。GC、dispose 和控制面清理必须
幂等，活跃调用持有自己的资源引用，不能仅靠 GC 或 TTL 推测业务执行已经结束。

引用必须区分：

- **持久化 deployment reference**：保护 immutable package/descriptor，支持精确版本引用，不表示该扩展当前获准执行。
- **setup/execution pin**：覆盖 opening、未完成 call/stream、`waitUntil` 和实际需要保留的 RPC capability；只有实际完成、
  dispose、确认的取消/断连清理或对应 generation 退出才能释放，不能把一个普通 JS 返回值当成全部工作完成。
- **缓存/session ownership**：Extension Worker 缓存和空闲 `HOST` 本身不是永久 in-flight pin；最后可执行部署引用与在途工作
  消失后，主动关闭空闲 session、失效缓存并允许停止 Provider，不能等待不确定的 GC 才结束 drain。

一个调用返回的 stream、callback 或 `RpcTarget` 仍按既有 Service RPC 的实际生命周期持有必要执行引用。缓存复用不延长某次调用
的 deadline，也不使它成为其他调用的 owner。上述区分不引入 idle timeout、周期扫描租约或自动扩缩容。

## 8. workerd fork 边界

fork 只新增通用机制：

1. 私有 `HostExtensionFactory` JSG binding，仅 loader host 可见；
2. `HostExtensionFactory.open(binding identity)` 返回 `HostExtensionPort`；
3. `HostExtensionPort.call()`、stream 和 dispose 的 JSG API；
4. 固定 Broker control fd 的 `AsyncCapabilityStream`/`TwoPartyVatNetwork` 接线与每消息一个 FD 的接收上限；
5. 从 fd-backed session capability 取得 FD，并为每个 session 建立/销毁 direct `TwoPartyClient`；
6. WorkerLoader dynamic env 仅向已验证 Package facade 委派该 capability，按 §4 的 Binding key 隔离实例；
7. 按 §7.7 分离 Port/连接与每次 IoContext 的生命周期，接入 GC、abort、eviction、Provider 重连与 generation fencing；
8. tenant 无法构造 Factory、改变 extension/provider identity 或取得底层 channel/raw FD。

不为每个扩展修改 workerd `Binding` union，不把用户 schema 编译进 fork，也不暴露任意 `JsRpcTarget`、Loader、ServiceDesignator、
raw fd 或 Cap'n Proto capability 给 tenant。fork 变更必须按[正式工作流](README.md)独立提交并协调更新四平台 binary pin；开发 binary
不能绕过 formal lock。

## 9. ocd Provider Manager

Provider Manager 是 `ocd` composition concern，使用一个按 Provider key 索引的有界 registry。每个 Provider supervisor 状态只表达：

```text
configured -> starting -> ready -> backoff/failed -> stopping -> stopped
```

Day 1 生命周期：

1. 第一次有效 session acquire 合并并发启动，只创建一个进程；
2. 启动使用 package 中经过 digest 校验的绝对 executable，不搜索 PATH；
3. `env_clear()`，0700 私有工作目录，独立 process group，只映射明确 fd；
4. 建立长期 Provider control channel，handshake/readiness 必须在有界 deadline 内匹配 ABI、package 和 schema digest；
5. ready 后多个 Binding session 可以复用进程，但每个 session 使用 `ocd` 创建的独立 direct socketpair，grant、limits 和 identity 相互隔离；
6. Provider crash 使该进程的全部 session 立即失效；在途调用返回稳定错误，绝不自动重放；
7. 已被按需启动且仍有当前授权的部署/执行引用时，按 bounded exponential backoff 重启；达到失败阈值后 provider degraded，
   其他 Provider 和普通 Worker 继续服务。尚未首次使用的配置项不因有历史部署而预启动；
8. 最后可执行部署引用及在途工作归零后，关闭空闲 session 并停止 Provider；内容保留引用不等于运行需求。首版不增加 idle timeout；
9. `ocd` shutdown 先停止 acquire、drain 有界时间，再 fence/close sessions，TERM、KILL、reap 完整 process group；
10. restart 只清理同时匹配 lease 中 start identity、binary digest、package digest 和 OS process identity 的旧 orphan，不接管旧
    Provider/control channel/session。即使扩展已从配置移除，也须按保留的 lease 身份完成旧进程清理；未知进程不 signal，无法确认
    旧进程退出时不得启动对应 replacement。新 authority 必须与旧 authority 完全隔离。

ProviderManager 不塞进 `WorkerdSupervisor`。W3 从现有 runtime/workerd 常驻 owner 提取必要的受控启动、停止、日志和回收接口，
保留 verified executable/FD/staging 到回收完成；若 P18 已完成相同提取则直接复用。P17 已有的 verified-exec、process-group 与
signal/reap 原语继续复用，但不把其短任务 API 当作通用常驻 owner，不复制第三套底层进程实现，也不引入 `Supervisor<Policy>`。
Provider 自己拥有 readiness、capacity、control/direct session、lease 接入与 restart 状态机；共享总预算只在实际跨产品 child/FD
竞争出现时由 composition root 增加。

## 10. 静态声明、绑定、装载与变更

### 10.1 启动时装载配置

1. operator 在本地准备已编译的 Package，在 `ocd` config file 声明精确版本、path、digest 与具名 grant；不调用扩展安装命令；
2. `ocd` 在持有 instance data-dir ownership 后，完整校验配置与包，准备不可变快照，再提交已验证身份与完整配置投影；
3. 按旧 lease 清理并确认上一代进程退出，建立新的 authority generation 与有界 ProviderManager，但不启动尚未使用的 Provider；
4. 缺少当前平台 binary、ABI 不支持、digest mismatch 或 grant 无效时启动校验失败，Provider 尚不执行，不借历史记录恢复旧授权。

### 10.2 部署 consumer

1. 上传边界只解析对已配置 extension ID、精确 version、entrypoint 和 grant name 的引用；
2. 核对当前配置、package ready、grant、consumer account、部署者权限与 env name，不接受 package/facade/权限定义；
3. 由 authority 生成 immutable Extension Binding descriptor、WorkerCode hash 和持久化依赖引用；
4. 不因为上传而启动 Provider，也不在 SQLite transaction 中做进程或文件 I/O。tenant 自己的 JS wrapper 只能调用已有 Binding，
   不能替换 Package facade 或通过同名入口取得 `HOST`。

### 10.3 首次调用及 Provider 恢复

1. RuntimeSource 返回已校验 descriptor，WorkerLoader 用 §4 的 Binding key 装载精确 Package facade；
2. `HostExtensionFactory` 为该实例建立 Port，按 §7.4/§7.6 向 `ocd` acquire，必要时合并启动 Provider；
3. 先登记 opening 并 attach Provider 端点，ACK 后重验授权与 generation，再交付 workerd 端点；
4. workerd 建立 direct `TwoPartyClient` 并注入 `HOST`；consumer 只得到 Extension Worker RPC stub；
5. 业务 payload 直连 Provider；Provider 单独重启后，缓存的 Port 为下一次新调用重新 acquire，不重放旧调用。

### 10.4 升级、撤销与内容保留

升级必须新增精确版本配置和 package；需要 rollout 时，在同一配置中同时保留新旧版本及所需 grant，重启 `ocd` 后再重新部署
consumer 切换引用。新旧 Provider 可以按需共存，旧 consumer 不追随新版本；Day 1 不承诺跨 `ocd` 重启的无中断热升级。

移除 extension/grant 或改变 grant scope/capabilities 必须修改 config 并重启。旧 generation 在正常 shutdown 或异常 control
断连时被 fence；新启动只认当前配置。缺失版本返回 `EXTENSION_VERSION_UNAVAILABLE`，缺失或 digest 不匹配的 grant 返回
`EXTENSION_GRANT_DENIED`；不自动选别的版本/grant，也不把旧 descriptor 改写为新授权。仍被历史部署引用不妨碍撤销授权，
但其 immutable package/descriptor 必须保留供核验；新 startup 不从历史引用自动启动已撤销 Provider。

移除配置不会自动删除包，也不能作为普通 cache GC 的触发器。物理清理属于 operator 显式停机维护，必须先确认配置、部署与
执行引用均归零、相关 Provider 已退出，并保留必要的不可变身份与恢复证据。没有扩展卸载 API/CLI，也不通过直接改数据库改变授权。
修改文件而未重启时，当前配置快照和 session 仍有效；需要立即撤销时应停止 `ocd`，不能把编辑磁盘文件当成已经生效。

## 11. 文件系统扩展示例

W3 的正式跨平台 reference extension 固定为一个最小只读文件系统 fixture：

```text
consumer env.FILES
  -> FileSystemExtension WorkerEntrypoint
  -> env.HOST
  -> fs-provider child
  -> openat/read/list
```

fixture 只提供 `list(path)` 和 `read(path)`：目录列表覆盖 unary 调用，文件读取覆盖 stream、backpressure、abort 和大小限制。固定测试树
包含普通文件、嵌套目录、大文件和指向授权根目录外的 symlink。Provider 必须将用户路径视为不可信输入，并按 operator grant 限制
只读根目录、单文件大小、总流量和并发；绝对路径、`..`、symlink escape、未知路径和超限读取必须稳定失败。

fixture 不实现 write、delete、watch、文件元数据全集或 Node `fs` 兼容层。它只证明 package、grant、两层 schema、unary/stream、路径
containment、Provider 生命周期和版本升级的通用机制；其他文件系统业务 API 由用户扩展自行定义。

Day 1 Native Provider 属于 operator-trusted code：manifest/grant 约束 Worker 能请求什么，不构成对恶意 Provider 的 OS sandbox。
如果正式文件系统 Provider 需要平台可验证的目录 containment，`ocd` 应打开根目录并通过受控 descriptor handoff 授予 Provider，或使用
独立 OS identity/sandbox；不能只把绝对路径和“请勿越界”配置当成安全边界。该 fd handoff 与各正式目标的 race/symlink 回归必须在
宣布强 containment 前完成。

## 12. macOS XPC 扩展示例

本节只说明相同 Provider 机制如何承载 macOS XPC，不是跨平台测试 fixture，也不是 W3 完成条件。真实 XPC 验证可以在后续 macOS-only
qualification 中独立执行，不能阻塞其他正式目标或 workspace Gate。

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

因此 Day 1 只支持 operator 在 `ocd` config file 中显式声明并信任的 native Provider，且只向同一不可变 Package 内经 digest
验证的 Extension Worker facade 注入 `HOST`。普通 account/tenant 只能部署 consumer 或其 JS wrapper，并引用配置中已授权的
Extension Version；不能上传、注册或替换获 `HOST` 注入的 facade。Provider 仍须独立执行 session grant 校验，不能只信任 facade。
若未来允许不受信 tenant 上传 native binary，必须先增加并资格化独立 UID、namespace/seccomp、macOS sandbox/VM 或同等级别
OS 隔离；不能把当前机制描述为安全的多租户 native sandbox。

### 13.2 必须保持的隔离

- 平台不向 Provider 注入 SQLite handle、master key、S3 credentials、RuntimeSource、control API 或 workerd internal token；
- consumer 不获得 `HOST`、Provider channel、grant 私有内容、binary path 或宿主拓扑；
- Extension Worker 不继承 consumer env、secret 或 binding；
- Provider stdout/stderr 有界且默认只记录 digest/分类，不进入 tenant response；
- Provider exception、XPC object description、路径、argv、schema payload 和原始 stderr 必须脱敏；
- 平台不为 Provider 配置公开 listener，Provider 合同禁止自行监听公开地址；私有 socket 位于 instance-owned 0700 目录并验证
  owner/mode/symlink/peer identity，这不等于对恶意同 UID Provider 的 OS 网络隔离；
- 只有 `ocd` 能创建和分发 direct session socketpair；workerd/Provider 到 `ocd` 的控制方向不接受 FD；
- tenant、Extension Worker 与 consumer 永不取得 raw FD；XPC/Mach handle、目录 FD 等宿主资源只进入 Provider，不通过 direct session
  暴露给 workerd；
- 扩展注册、版本与 grant 只来自主配置并在重启时生效；Worker 调用最多触发已授权 Provider 的按需启动，不能修改扩展配置；
- capability version、ABI、schema 或 package digest 不匹配一律 fail closed，不做旧版 fallback 或协议猜测。

## 14. Limits、错误与可观察性

平台 limits 至少包括：

- 配置声明数、每版本 grant 数、package 大小、module 数和 native binary 大小；
- 每 account/instance 的 Extension Version 与 active Provider 数；
- 每 Provider session、并发 call、排队、unary frame 和 stream byte 上限；
- call deadline、startup/readiness deadline、drain deadline；
- Provider CPU、地址空间/RSS（按目标可执行能力明确）、打开 fd、stdout/stderr；
- Broker/Provider 每消息 FD、instance/session FD 总数和 direct-channel queue/backpressure；
- restart backoff、连续失败阈值和 retained failure evidence 大小。

稳定错误至少区分：

```text
EXTENSION_NOT_CONFIGURED
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

- 扩展安装/卸载/授权管理 API、CLI 或控制台写入口；Worker upload 注册扩展；
- 扩展配置 file watcher、热重载、SIGHUP/环境变量覆盖或从 SQLite 恢复旧授权；
- tenant 自定义可获得 `HOST` 的 facade，或替换已配置 Package 中的 facade；
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

### 16.1 W3 G0 必须先于 Host ABI 冻结和完整实现

先用正式 workerd pin 的源码基线构建最小候选 bridge，接通选定 Rust Broker 与参考 Provider SDK，记录实际源码 revision、
依赖版本、目标平台与 binary digest。G0 必须验证完整 `attach -> ACK -> FD handoff -> direct call -> close`，而不是只证明
`sendmsg()` 能发送一个 FD。至少覆盖：

- C++ 与 Rust 的 ancillary-FD contract、capability/FD 对应关系、并发 handoff 和单向 `maxFdsPerMessage`；
- 截断、FD overflow、取消、超时、Provider ACK 前后失败及 acquire/revoke 竞争，无未归属端点或引用泄漏；
- unary 与有界 stream、abort/backpressure，以及 Broker 失联后 direct channel 确实被 fence；
- 在不重启 workerd/重新部署 consumer 的前提下，Provider 重启后新调用恢复，旧调用不被重放；
- Binding-scoped Port 与每次 IoContext 的所有权、两个 Binding 对同包的隔离，覆盖正式支持平台所需的底层差异。

只有 G0 证明选定 stack 可行后，才冻结 Host ABI schema、FD handoff framing 与 SDK 接口并推进完整配置/持久化/生命周期实现。
Rust stack 缺失的 FD 支持由平台拥有的窄 transport/SDK 补齐并进入同一验证路径；不引入第二套 fallback 协议，不改为 HTTP，
也不以 upstream master 文档、孤立 C++ demo 或旧 G0 结果代替证据。最终仍需在更新后的正式四平台 pin 上完成产品资格化。
一次性探针遵守仓库临时目录规则；需要长期保留的失败与生命周期回归进入正式测试，不恢复已退休的 POC 入口。

### 16.2 单一纵向实现路径

G0 通过后按一个完整纵向切片实施，不保留第二套协议或占位 registry：

1. **Config/authority/package**：主配置解析、Package 验证、原子快照、配置投影、immutable version、具名 grant、descriptor 与引用；
   没有独立扩展管理 API/CLI；
2. **Process substrate**：提取 §9 的最小常驻 owner 接口，复用 P17 verified-exec/signal/reap；P18 已提取的接口直接复用，
   不把 Xberg 短命任务接口用作长期 Provider supervisor；
3. **Provider lifecycle/control**：content-addressed executable、ProviderManager、handshake、limits、crash/backoff、shutdown/orphan 清理；
4. **Direct data plane**：当前配置授权、opening registry、socketpair、FD handoff、attach/ACK、撤销完成点和 authority 失联 fencing；
5. **workerd bridge**：Factory/Port、Broker control fd、direct `TwoPartyClient`、按调用 IoContext、重连、GC/abort/eviction 与引用释放；
6. **Extension Worker target**：按 Binding key 隔离 Package facade、精确版本 RPC stub、独立 env/limits、不可由 tenant 替换；
7. **Reference extension**：只读文件系统 provider + facade 证明静态配置、两层 schema、unary/stream、路径 containment、两 Binding
   不串权限、崩溃恢复、重启应用配置以及新旧版本依赖。

macOS XPC Provider 不属于上述实施主线。需要验证真实 XPC 集成时，另做 macOS-only qualification，覆盖签名 binary、Mach service、
拒绝、interrupt、restart 和系统权限边界。

Rust ownership 遵守现有 crate 方向：core 拥有配置类型与校验；storage 持久化已验证配置投影、身份和引用，不新增第二套配置 authority；
workers 拥有 immutable descriptor/runtime snapshot；runtime 拥有 workerd binary 与 supervisor 低层原语；service 组合当前配置、
package/grant、ProviderManager 和私有 Broker。TypeScript facade/loader 在 `packages/runtime/`；workerd JSG/Cap'n Proto 修改只在
`third_party/workerd/`。

## 17. 验收

完成声明至少需要：

- 只从 `ocd` config file 声明扩展/授权：相对 path 按 config 所在目录解析，cwd 改变不影响解析；只生成既有 data directory 内的快照；
- 未配置、digest mismatch、unknown ABI/schema/platform、缺 grant、scope 不匹配和权限扩大全部 fail closed；manifest 或历史 SQLite
  记录不能自行启用扩展，Worker upload/API/CLI 不能注册扩展或修改 grant；
- 修改配置不热生效；重启后完整应用新增/移除/授权变更，错误配置不回退旧投影。撤销不被 deployment pin 阻止，也不删除旧内容；
- 两个 consumer，以及同一 consumer 的两个 Binding，引用同一包而使用不同 grant 时共享 Provider 但不共享带 `HOST` 的 facade，
  交替/并发调用不串 session、模块状态或宿主权限；相同 grant 的两个 Binding 仍按独立 key 隔离；
- 普通 tenant 上传同名入口或自定义 facade 不能取得 `HOST`；只有当前配置包内精确 code digest 的 facade 可被注入；
- 精确 Extension Version/grant 不随另一个配置版本或同名新 grant 改变；需要重新部署 consumer 才切换 digest；
- consumer 无法取得 `HOST`、Factory、Provider 路径、grant 或内部 channel；
- 正式 pinned workerd 证明 Cap'n Proto FD handoff 可用，方向性 `maxFdsPerMessage`、FD overflow/截断和 capability lifetime fail closed；
- steady-state unary/双向 stream 只经过 workerd-to-Provider direct channel，backpressure、abort、deadline 和 payload limits 通过；
- Host ABI 与用户 business schema digest/ordinal 独立校验，任一 mismatch 不建立 session；
- Provider crash 不自动重放调用；不重启 workerd、不重新部署 consumer，缓存 Port 的下一次新调用在 Provider ready 后恢复；
- 单次 timeout/abort 不关闭其他并发调用；旧 stream 不被接到新 generation，dispose/revoke 后不自动重连；
- acquire 在 Provider ACK 前后与 revoke/close 竞争时，opening 和交付中的 endpoint 均可被 fence，没有撤销后仍可用的新 session；
- `ocd` crash/Broker EOF 后两端停止 direct 业务调用、回收端点；下一次启动先清理已验证 orphan，不接管旧 session 或错误 signal 未知进程；
- 区分内容保留引用、setup/execution pin 和缓存 ownership；返回 stream/capability 后仍持有必要 pin，空闲缓存不造成永久 busy；
- workerd restart、`ocd` restart、extension upgrade、drain 和删除不泄漏进程、fd、socket、临时目录或 pin；
- malicious path/schema/frame/stderr 不泄漏宿主路径、payload、secret 或拓扑；
- active Provider 上限和单 Provider overload 不影响普通 Worker及其他 Provider；
- 只读文件系统 reference extension 覆盖目录 unary、文件 stream、traversal、symlink/race、读取限制和崩溃恢复；
- 正式 fork commit、四平台 workerd archive/digest、compatibility date/flags、single-binary offline startup 和完整产品 Gate 协调更新。

可选的 macOS XPC qualification 可以覆盖签名/entitlement 不足、unknown service、interrupt/invalidate、Provider restart 和真实成功调用；
其缺失不影响 W3 完成声明。

文档阶段只运行文档检查；实现涉及安全、协议、持久化、process lifecycle 和 workerd fork，最终必须按仓库规则完成对应 focused coverage、
真实 runtime Gate 和一次完整 workspace Gate。

返回[workerd 路线](README.md)与[文档索引](../README.md)。

# W3：用户可扩展原生 Binding 与 Provider 子进程

状态：**planned（2026-09-18）**。Day 1 按 KISS 收敛为本地扩展加载器：`ocd` 静态注册，Worker 通过 Wrangler
`services + props` 使用。Host ABI/FD transport 须先完成 G0；配置解析、运行时桥接、正式 fork pin 和产品 Gate 尚未完成。
本文配置与代码是待实现合同，不表示当前版本已经支持本地扩展目标。macOS XPC 是可选资格项，不阻塞 W3 完成。

## 1. 用户结果与边界

`ocd` 负责加载、调用和回收；operator 负责扩展内容、升级、兼容和回滚。平台不做扩展包管理或版本管理。

```text
ocd config：名字 -> 本地扩展
wrangler.json：Binding -> service 名字 + props
consumer：env.FILES.readText(filename)
Extension Worker：this.ctx.props + 方法参数 -> env.HOST
Native Provider：独立子进程执行宿主调用
```

扩展由一个 JS facade（Extension Worker）和一个 native executable（Provider）组成。facade 用 `WorkerEntrypoint` 暴露业务
API；fork 只提供通用私有 `HostExtensionPort`，不内置文件系统、数据库或 XPC 业务接口。consumer 到 facade 使用原生 Service
RPC；workerd 到 Provider 使用 Cap'n Proto 直连数据面，`ocd` 只处理 session 建立、监督和关闭，不转发业务 payload。

Native Provider 是 operator 显式配置并信任的代码，不是 tenant 上传的 native code；不把用户动态库 `dlopen()` 到 `ocd` 或
workerd。新增扩展不需要重新编译平台，生产启动不下载或编译扩展。

## 2. ocd 只静态注册本地扩展

主配置只需要本地名字和路径：

```toml
[extensions.local-files]
path = "./extensions/files"
```

`local-files` 是本实例供 `services[].service` 引用的名字，不是全局 ID。`path` 指向本地扩展目录，相对于实际加载的
`ocd` config file 所在目录解析，也接受绝对路径；不根据进程 cwd 猜测，不展开 shell、环境变量或网络 URL。

目录中的 `extension.toml` 只描述加载入口，不承担包身份、授权或版本管理：

```toml
[worker]
main = "worker/index.js"

[native]
executable = "native/files-provider"
```

这两个路径相对于扩展目录解析。operator 提供适合当前机器的已编译 JS bundle 和 Provider executable；Day 1 不要求多平台
打包矩阵、业务 schema 登记、`checksums.json`、扩展 `id`、`version` 或 digest。默认 RPC 入口是 facade 的 default export；
需要命名入口时直接使用现有 `services[].entrypoint`，不另设一套入口选择字段。业务 codec、类型及依赖由扩展作者打包。

启动时读取配置与 facade，验证文件可读、模块可加载、Provider 可执行及基本大小限制；Provider 启动仍复用既有 verified-exec
规则。平台生成的工作目录、必要 staging 与进程恢复记录只放在既有 data directory。不建 content-addressed extension store、
历史内容库、版本登记表或配置授权投影。扩展源文件仍由 operator 管理，`ocd` 不改写或删除它们。

配置只在 `ocd` 启动时读取。正常更新方式是停止 `ocd`、替换模块文件或修改路径、再启动；同一路径内容变化是正常更新，
不比较历史 digest，不要求改版本号。运行期间不监听文件、不热替换；operator 自行修改正在使用的文件不属于一致性保证范围。
不提供扩展安装/卸载/授权管理 API、CLI、控制台写入口或 SIGHUP 热加载。显式配置错误使启动校验失败，不回退历史配置。

## 3. Worker 使用现有 services Binding

Worker 在自己的 `wrangler.json` 中选择扩展和参数，不增加新的顶层 Binding 类型：

```json
{
  "services": [
    {
      "binding": "FILES",
      "service": "local-files",
      "props": {
        "directory": "invoices",
        "encoding": "utf-8"
      }
    }
  ]
}
```

consumer 正常调用：

```ts
const text = await env.FILES.readText("2026-09.csv");
```

`services`、`entrypoint`、`props` 与 `ctx.props` 复用现有 Service Binding 合同。Cloudflare 的
[Context 文档](https://developers.cloudflare.com/workers/runtime-apis/context/)已定义通过 Service Binding 参数配置自定义资源
接口；[原生 RPC 文档](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)定义方法调用语义。
**把 service 名解析为本地扩展是 open-compute 的 W3 能力，不声称 Cloudflare 会装载本机模块，也不声称当前 open-compute 已实现。**

部署边界沿用现有身份、部署权限、Binding 名称、props 格式/大小和目标存在性校验。扩展声明中不增加 `account_id`、具名 grant
或 Worker 白名单；哪些 Worker 引用扩展由其部署配置决定。配置扩展意味着把它提供给本实例中有权部署相应 Binding 的主体，
不是面向不受信租户的细粒度宿主权限隔离。平台现有的 account/部署校验不因 W3 被绕过。

本地扩展名与普通 Worker service 名不得冲突：启动时检查已有名称，后续 Worker 创建/部署也检查冲突，明确报错而不设覆盖优先级。
目标未匹配扩展时沿用普通 Service Binding 解析；两者均不存在则报错。内部描述符区分普通 Worker 目标和扩展名字，已解析的
扩展目标在被移除后只报不可用，不能悄悄 fallback 到同名 Worker；普通 Worker 目标也不能被新配置的扩展接管。

只向 `ocd` 配置所指向的 facade 注入 `HOST`。普通 Worker 上传同名入口或自写 wrapper 都不能注册/替换扩展、取得 Factory、
自选 Provider executable 或读取 raw FD；wrapper 只能调用已经声明的 Binding。

## 4. 参数直接通过 props 传递

固定的 Binding 参数放 `services[].props`，每次变化的数据放方法参数。Extension Worker 在 `this.ctx.props` 读取前者，再由
自己的代码合并为业务请求交给 Provider；平台不自动把 props 映射为 Provider 全局环境变量、启动参数或权限。

下面只演示传参链路；`codec.js` 及其参数校验由扩展实现，`HOST` 接口须经 G0 固定：

```ts
import { WorkerEntrypoint } from "cloudflare:workers";
import { decodeText, encodeReadText, parseFileProps } from "./codec.js";

type FileProps = { directory: string; encoding?: string };
type ExtensionEnv = {
  HOST: {
    call(method: number, payload: Uint8Array): Promise<Uint8Array>;
  };
};

export default class FileSystemExtension extends WorkerEntrypoint<
  ExtensionEnv,
  FileProps
> {
  async readText(filename: string): Promise<string> {
    const props = parseFileProps(this.ctx.props);
    const request = encodeReadText({
      directory: props.directory,
      encoding: props.encoding ?? "utf-8",
      filename,
    });
    const response = await this.env.HOST.call(1, request);
    return decodeText(response);
  }
}
```

`props` 沿用现有 Service Binding 支持的 JSON 参数与缺省语义，不增加参数注册表、schema 管理、签名或单独参数同步协议。
平台负责基本格式、大小限制和准确传递；扩展负责字段含义、缺省值、业务校验及安全使用。普通业务参数不因名称为
`directory`、`permissions` 等而自动成为平台授予的宿主权限；敏感值不得作为普通 props 明文写进项目配置。

Provider 所需的参数由 facade 编码进每次业务调用，平台不必理解或重复保存这些字段。Provider 必须验证输入，包括文件路径等；
不能只依赖 facade 检查。扩展业务路径如何解释属于扩展 API，不由 `ocd` 按 config/cwd 隐式重写。

同一扩展可以绑定两次，例如 `INVOICES` 的 `props.directory` 为 `invoices`，`REPORTS` 的为 `reports`。两份 props 随各自
Binding 传给对应 entrypoint，不能写进共享 Provider 的可变全局配置，否则交替/并发调用会互相影响。

## 5. 部署引用、缓存与共享范围

consumer 部署继续保存正常 Service Binding 描述符：Binding 名称/身份、扩展目标名字、entrypoint 和 props。复用现有
Worker 部署持久化、规范化与 WorkerCode hash 规则，不为 W3 再建 Extension Version、grant、内容登记或历史依赖表。

**部署固定的是扩展名字和 Binding 参数，不是扩展实现。** 同一路径更换实现并重启后，已有 consumer 使用新实现，不需要
重新部署；修改 consumer 的 props/entrypoint/目标则像其他 Binding 一样重新部署。回滚 Worker 只恢复其自身代码和 Binding
参数，不回滚本地扩展。模块兼容、配套 facade/Provider 和回滚文件由 operator 负责。

运行态只区分三种对象：

| 对象 | 所有权与共享粒度 |
| --- | --- |
| 扩展配置及 facade 字节 | 当前 `ocd` 启动配置；只读内容可共享，不保存历史包 |
| Provider process | 当前 `ocd` generation 内每个扩展名字一个；不按 props 创建进程 |
| 带 `HOST` 的 facade 与 session | 按 consumer 部署身份 + Binding 身份隔离，限定在当前 workerd generation |

Binding 身份来自已验证部署，不由业务参数自报。不同 consumer，或同一 consumer 的两个 Binding，不共享 `HOST`、session
或 facade 模块级可变状态，即使名字和 props 相同也不合并实例。复用 Service RPC transport，不直接复用普通 Service Binding
按目标 Worker 共享实例的缓存 key。props 更新产生新的部署身份，不需另加 props digest 作为用户字段。

`ocd` 打开 session 时检查当前扩展配置、现有部署 Binding 身份和 runtime generation。RuntimeSource 只暴露装载所需的
不透明目标，不向 consumer 暴露 Provider 路径、内部 fd、控制凭据或宿主拓扑。运行中的调用仍有资源引用，但没有保护历史
扩展内容的 deployment pin；空闲 facade 缓存也不能被当成永久在途调用。

## 6. Broker 控制面与直连数据面

`ocd` 为 workerd 和每个 Provider 建立私有 control socket。固定 Host Extension fd 与现有 workerd control-fd 分开；
fd 持有本身是 process capability，不把内部 token 放进 argv、环境或日志。每个 Binding 的 session 建立流程为：

1. workerd 通过 Broker 提交平台生成的 Binding 身份；`ocd` 校验当前配置/部署、generation 和容量，登记 opening session。
2. `ocd` 按需启动对应 Provider，创建 Unix socketpair，将端点 A 交给 Provider 并建立 session。
3. Provider attach ACK 后，Broker 确认该 opening session 仍有效，再把端点 B 交给 workerd；失败/取消则关闭未交付端点。
4. workerd 建立 session-scoped `TwoPartyClient`；`ocd` 关闭自己的数据端点副本，此后业务 payload 直接往返 workerd/Provider。

```text
setup: workerd ──Cap'n Proto──> ocd Broker ──Cap'n Proto──> Provider
data:  workerd <──────────── session-scoped Cap'n Proto ────────────> Provider
```

首版每个 session 一个 socketpair，不加连接池、session bearer token、HTTP fallback 或自动三方 introduction。
Cap'n Proto C++ 的 [`getFd()`](https://github.com/capnproto/capnproto/blob/master/c%2B%2B/src/capnp/capability.h)及
[`AsyncCapabilityStream` / `TwoPartyVatNetwork`](https://github.com/capnproto/capnproto/blob/master/c%2B%2B/src/capnp/rpc-twoparty.h)
提供 FD handoff 基础；它不证明选定 Rust stack 自动兼容，必须由 G0 实测并补齐所需的窄 transport/SDK。

所有 data socketpair 均由 `ocd` 创建。control channel 的 `ocd -> workerd/Provider` 方向每消息最多一个 FD，反方向不接受 FD；
业务 direct channel 不传宿主 FD。consumer/facade 只见业务 API/字节流，不见 raw fd、Mach handle 或任意 Cap'n Proto capability。

Host ABI 只定义 Broker/session 建立与关闭、Provider readiness、numeric method ID、bounded opaque Data、stream、deadline、
取消和 generation。**通信 Host ABI 是否匹配仍要检查，业务模块 version 则不属于平台。** 用户 codec/schema 由 facade 与 Provider
自带，平台不登记、哈希或解释其业务 schema，不编译进 `ocd`/workerd；默认使用扩展自己的 Cap'n Proto codec。

## 7. 生命周期只管理正在运行的资源

### 7.1 Provider 与 HostExtensionPort

Provider 首次有效调用时按需启动，并发 acquire 合并为一次启动；启动后保留至 `ocd` 停止，不按部署历史或扩展版本管理启停，
不做 idle timeout、进程池、自动扩容或旧版本并存管理。crash 后当前调用失败，后续新 acquire 可按有界 backoff 重新启动，
达到失败阈值则报告该 Provider degraded，不无限重试或重放已经发送的调用。

`HostExtensionPort` 是 Binding 级连接 owner，不属于第一次调用的 IoContext。每个 call/stream 单独持有当前执行上下文、
deadline、取消与资源引用。Provider disconnect 后旧调用、stream 和远端对象失效；缓存 Port 可为后续新调用重新 acquire，
不要求重启 workerd 或重新部署 consumer。不能把旧 stream/对象状态静默接到新 session。

单次 timeout/abort 只取消该调用，不关闭同 session 的其他正常调用；channel/protocol 故障则使整个连接失效。dispose、eviction
或 generation 失效后的 Port 不自动重开；重新装载必须按当前配置和部署创建新 Port。返回 stream、callback、`RpcTarget` 或
`waitUntil` 工作时沿用现有执行保活语义，实际结束后释放引用；GC 与空闲缓存不替代执行完成确认。

### 7.2 关闭、控制面失联和重启

session 的 open/close 由一个有界 owner 串行化。等待 Provider ACK 的 opening session 同样受关闭约束，关闭后晚到的 ACK/FD
不得重新激活。正常 shutdown 停止新 acquire，给在途调用有界 drain 时间，再关闭 sessions、TERM/KILL 并回收 Provider 进程组。
关闭 Broker 自己的 duplicate FD 不能代替关闭两端；未响应的 Provider 由 supervisor 终止，影响其全部 session。

`ocd` 不在数据面，因此必须明确规定 control disconnect 的后果：workerd 停止该 authority generation 的调用并关闭 direct
端点；Provider 停止接受业务、关闭 sessions 并有界退出。两端不能在失去 Broker 后继续直连服务；取消或断连不代表宿主副作用
已经回滚。Provider 不得 daemonize、脱离受监督进程组或把内部 FD 转交给未受监督进程。

新 `ocd` 只清理按 lease/OS identity 验证的旧 orphan，不接管旧 Provider、控制连接或 session；无法确认身份则不 signal 未知
进程，也不启动对应 replacement。即使配置已移除，仍按既有恢复记录清理旧进程。沿用进程 owner 必需的 executable identity、
FD/staging 或短期摘要，不把这些实现细节升级为跨启动的扩展版本锁、内容历史或消费者依赖。

移除扩展并重启后，引用该名字的 Binding 返回不可用，无关 Worker 继续运行；不阻止移除、不改写旧部署、不保留旧扩展字节。
重新配置相同名字后，已有 Binding 可使用当前实现。平台不负责删除、还原或迁移 operator 的扩展源目录。

## 8. 信任、限制与错误

Provider 具有其 OS 进程身份可取得的宿主权限；进程边界隔离普通崩溃，但 `env_clear()`、props 和 session 不是针对恶意同 UID
代码的 OS sandbox。operator 必须信任加载的扩展及其公开 API。W3 不为任意不受信 tenant 上传 native code 提供隔离保证。

平台不注入 SQLite handle、master key、S3 credentials、控制 API 或 workerd 内部 token；facade 不继承 consumer env/secrets。
Provider 使用明确 executable、清空后的环境、私有工作目录和明确 fd，不搜索 PATH、不运行 shell/build/post-install script，
不提供任意 argv/env 配置。平台不创建 Provider 公网 listener；SDK 合同禁止 Provider 自行公开监听，不把这一约定描述成 OS 网络隔离。

限制只覆盖实际资源：扩展声明/模块大小、Provider/session/FD 数、调用并发与排队、frame/stream 字节、backpressure、deadline、
启动/退出时间、bounded stdout/stderr 和目标平台支持的进程资源限制。复用既有错误映射：配置/目标不存在、ABI 不匹配、
Provider 不可用/崩溃、调用超时/取消、payload 过大、过载和不支持的方法应可区分；不再暴露扩展版本或 grant 错误。

错误和日志不泄漏 raw stderr、宿主路径、payload、props、XPC object description 或 secret。指标按本地扩展名字、结果类、
延迟、字节、session 数和重启次数组织，不使用版本/digest 作为扩展身份。单个 Provider 的失败不应让不依赖它的 Worker 全局不可用。

## 9. 实现复用边界

现有 [Service Binding](../implemented/p3-2-service-bindings.md)已提供原生 RPC、stream、callback 和 props 传递基础；
`crates/storage/src/services.rs` 的 `props_json` 与 `packages/runtime/src/services/transport.ts` 的 entrypoint props 路径应复用。
内部目标模型增加本地扩展分支，不伪造普通 Worker ID、创建隐藏部署或另建一套公开 Extension Binding 协议。普通 Worker 目标
继续遵守既有 Service Binding 合同，W3 的名字引用不改变其解析、权限与生命周期语义。

[P17](../implemented/p17-host-process-infrastructure.md)已共享 verified-exec、process-group 与 signal/reap 原语，但尚不是
通用常驻 child API。W3 从现有 workerd owner 提取必需的受控启动、日志、停止和回收接口；若 P18 已完成同一提取则直接复用。
ProviderManager 自己拥有 readiness、capacity、session 与 backoff，不塞进 `WorkerdSupervisor`，不拿 Xberg 一次性任务接口
运行长期 Provider，也不增加万能 `Supervisor<Policy>` 或没有实际需要的全局 Process Coordinator。

fork 只增加私有 Factory/Port、Broker FD 与 direct client 接线、受约束 loader 委派和 IoContext/GC/断连生命周期；不为每个
扩展改 Binding union。仅配置 facade 可获 `HOST`。fork 修改遵循[正式工作流](README.md)，最终协调更新正式四平台 pin；
删除扩展业务版本管理不意味着放松平台自己的 workerd pin、ABI 或已有 Worker 部署数据完整性合同。

core 拥有配置类型，workers/storage 复用现有部署 Binding 描述与持久化，runtime 拥有进程底层，service 组合当前扩展配置、
ProviderManager 与 Broker；TypeScript loader/transport 在 `packages/runtime/`，fork 在 `third_party/workerd/`。
不新增扩展包/版本/grant 数据表，不在数据库事务中做进程或文件 I/O，已发布迁移仍不可改写。

正式 release 仍为单个 `ocd` executable；外部扩展由 operator 单独提供，不属于平台 release artifact。必要运行数据继续遵守
[单二进制分发](../references/single-binary.md#磁盘与进程)的同一 data directory 合同。

## 10. 参考扩展与可选 XPC

正式跨平台 fixture 保留最小只读文件系统：`list(path)` 覆盖 unary，`read(path)` 覆盖文件 stream、backpressure、abort
和大小限制。两个 Binding 用不同 props 选择测试根目录内的不同相对目录，交替/并发调用不串参数或 session。Provider 独立检查
绝对路径、`..`、symlink/race、未知路径和读取限额，不能把 props 中任意路径当作无限制授权。

fixture 不实现 write、delete、watch、Node fs 兼容或文件元数据全集；只证明加载、props、两层通信、路径 containment 与
生命周期。这里的 containment 是参考扩展对 Worker 输入的实现责任，不宣称平台隔离了恶意 Provider 的宿主权限。

macOS 扩展可由签名 Provider 使用 `NSXPCConnection`/XPC 连接 launchd 管理的服务；签名、entitlement、bootstrap namespace
与目标服务鉴权仍遵守 [Apple XPC](https://developer.apple.com/documentation/xpc) 和
[NSXPCConnection](https://developer.apple.com/documentation/foundation/nsxpcconnection) 合同，配置名字或 props 不能绕过它们。
真实成功、拒绝、interrupt/invalidate 和 restart 单列 macOS-only qualification，不是 W3 跨平台完成条件。

## 11. 实施顺序与非目标

先做 W3 G0：用正式 workerd 源码基线的候选 bridge、Rust Broker 与参考 Provider，证明完整 FD attach/ACK/handoff、直连
unary/stream、关闭与 Provider 恢复。记录实际输入；验证跨语言 ancillary FD、方向/数量上限、取消/截断和资源回收，不以
单独 C++ demo 或 upstream 文档代替。选定窄 transport/SDK 后固定 Host ABI，正式验收仍需匹配更新后的 workerd pin。

之后按一个纵向切片实现：静态入口与 Service 目标解析/props；最小常驻进程 owner 与 Broker；fork Factory/Port 和 Binding
隔离；只读参考扩展及生命周期回归。一次性探针遵守仓库临时目录规则，保留必要产品回归，不恢复已退休 POC 或第二套 fallback。

Day 1 不做包安装器、版本注册/比较/锁定、历史内容留存与删除保护、扩展自动升级/回滚、细粒度 grant/白名单、热加载、
marketplace、远程下载、动态库加载、tenant-native sandbox、集群调度或进程池。业务版本变化与兼容由 operator 负责，
平台只对当前配置下的加载、通信和回收负责。

## 12. 验收

完成声明至少覆盖：

- `ocd` 只从主配置读取名字/path，config-relative 路径不受 cwd 影响；不存在版本/digest/account/grant 必填项或动态注册入口。
- Wrangler `services + props` 经现有部署链路传给 `ctx.props`；缺省、大小限制、命名 entrypoint 与常规 Service 行为不回归。
- 扩展/Worker 名称冲突双向报错；目标不存在或移除后不可用，不会切到另一类同名目标；无关 Worker 继续服务。
- 两个 consumer 及同一 consumer 两个 Binding 共享 Provider，但 props、`HOST`、session 和 facade 可变状态不串；Provider 收到
  facade 编码后的固定参数及本次方法参数，未被全局 env/argv 覆盖。
- 同一路径替换模块并重启，无需改业务版本或重新部署 consumer 即使用新实现；修改 props 仍须部署 Worker，不保留历史扩展包。
- 普通 Worker 不能注册/替换获 `HOST` 的 facade、构造 Factory 或取得宿主 FD/凭据；Provider input/path 与错误输出受控。
- 正式 pin 上的跨语言 FD handoff、直连 unary/stream、backpressure、deadline、abort、超限和 ABI mismatch 正确失败并释放资源。
- Provider crash 不重放旧调用；不重启 workerd/不重新部署 consumer，新调用能重新 acquire；单次取消不杀掉其他正常调用。
- opening 与关闭竞争、Broker EOF、workerd/`ocd` 重启、dispose/eviction 和 orphan 清理不泄漏进程/FD/执行引用，不误杀未知进程。
- 只读文件系统 fixture 的路径/读取限制与崩溃恢复通过；正式 fork、四平台 binary pin、离线单文件启动及对应产品 Gate 协调验证。

文档阶段只做文档检查；实际实现须完成对应 focused coverage、真实 runtime Gate 和一次完整 workspace Gate。可选 macOS XPC
qualification 的缺失不影响 W3 完成声明。不得把本次文档更新、G0 计划或示意代码当成已通过的 runtime 证据。

返回[workerd 路线](README.md)与[文档索引](../README.md)。

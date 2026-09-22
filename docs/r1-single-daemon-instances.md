# R1：单 OCD daemon、多 Instance 与单一身份重构

状态：**planned**。2026-09-22。源码基线：`51aa520c973b90f749797fe79977072754cf450f`。
本文统一定义目标架构、重构步骤、删除清单与验收要求；代码尚未实施。

## 1. 最终模型

**一台机器至多一个常驻 OCD daemon；一个 Instance 对应一份 `compute.toml` 和一个独占数据目录。内部只有 `InstanceId`，不再存在 account 实体或第二套平台身份。**

```text
OCD daemon
├── ocd.toml：机器监听、网关、实例配置清单
├── 全局单例锁 / control socket / 一个受监督的 Caddy（可选）
├── Instance A
│   ├── compute.toml + data/control.sqlite 中的唯一 InstanceId
│   ├── 独立存储、密钥、凭证、调度、日志、运行时状态
│   ├── 自己的 workerd supervisor
│   └── 自己的 native extension Providers
└── Instance B
    └── 相同结构，互不复用可变状态
```

“一个 OCD”指一个常驻服务，不是禁止短命 CLI、workerd、Provider、解析器或 Caddy 子进程。不同 Instance 的失败和启停不应主动终止其他 Instance；daemon 自身崩溃仍影响全部实例，不宣称进程内的硬故障隔离。

## 2. 身份与持久化

| 项目 | 唯一规则 |
| --- | --- |
| 内部类型 | `InstanceId`，统一序列化为 32 位小写十六进制字符串；可用 UUID v7 的无连字符形式生成 |
| 创建与权威 | 新数据目录初始化时生成一次，保存在 `control.sqlite` 的实例元数据中；以后只读取，不重新派生 |
| 配置 | 配置描述实例并指向数据目录，不再存储另一份 ID，也不从配置路径或内容计算 ID |
| 名称 | 可选 `instance.name`，仅作为显示名和本机 CLI 选择器，不参与存储、授权、域名或密钥派生 |
| 公开兼容字段 | `/accounts/{account_id}/…` 中的值就是 `InstanceId` 的原始字符串，不转换身份 |

移除路径哈希式 Instance ID、独立 `PlatformId`、`AccountId`、`default_account_id`、公开 account ID 派生及其映射表。`WorkerId`、`VersionId`、资源 ID、启动代次与 session ID 仍有各自用途，不属于需要合并的实例身份。

初始化只接受真正的新数据状态。已有目录中的身份缺失、格式错误或不支持的 schema 必须报错，不得通过生成新 ID“修复”。读取 status 不初始化数据、不迁移数据库。

同一 daemon 拒绝重复配置路径、重复数据目录、相互嵌套的数据根，以及不同目录中重复的 InstanceId；可选名称也必须唯一。保留数据目录独占锁，不能只依靠内存去重。复制配置并指向原数据不是新实例；复制完整数据也不是自动创建新身份。

移动或重命名配置不改变身份，但必须保证解析后的 `data.path` 仍指向原数据。搬迁完整数据后保留原 ID。创建独立实例必须初始化新数据目录；本阶段不实现带资源重写的实例克隆工具。

## 3. 配置只分两层

### 3.1 `ocd.toml`：机器共享资源

以下为目标配置示意，不是当前 CLI 已支持的配置。

```toml
[daemon]
state_dir = "/var/lib/open-compute"

[server]
public_bind = "127.0.0.1:8787"
# 需要公开 HTTP 时可显式分离 admin_bind；默认仅 loopback 合并入口。

[[instances]]
config = "/srv/dev/compute.toml"
autostart = true

[[instances]]
config = "/srv/prod/compute.toml"
autostart = true
```

机器级配置还拥有全局网关 listener、challenge DNS listener、信任的反向代理、原始 Caddyfile 列表，以及必要的整机资源上限。单例锁与 control socket 使用安装时确定的固定系统路径，**不随 `state_dir`、cwd、用户 HOME 或 `--config` 改变**。

实例清单只保存配置路径与 `autostart`。不再另建持久 registry 来复制 ID、配置 digest、数据路径、binary path、OS service identifier 和运行状态。内存索引从清单及实例权威重建；没有全局实例数据库。

### 3.2 `compute.toml`：实例自己的意图

```toml
[instance]
name = "dev"

[data]
path = "./data"

[extensions.local-files]
path = "./extensions/files"
```

此处只展示边界相关字段。密钥和认证仍使用受验证的 file/env 引用；现有存储、KV/R2/D1、AI、调度、资源限额等产品配置保留在实例内。认证从机器 listener 配置中拆出，成为实例级配置。密钥和默认本地对象目录从该实例数据根派生，不再隐式落到全局默认目录。

实例配置不得包含公共监听端口、OS service scope、daemon PID、全局 Caddyfile 或另一份 account/platform ID。实例可声明自己的公网 base domain；不得声明绑定 80/443/53 的所有权。

配置内相对路径始终相对该配置文件解析。机器配置与实例配置没有隐式继承、层层 merge 或错误时 fallback。启动只使用明确的 daemon 配置入口，`./compute.toml` 只能选择实例，不能另起 daemon。

## 4. 内部不保留 account

唯一保留 account 命名的地方是 **Cloudflare 对外兼容协议边界**，核心入口为：

```text
/client/v4/accounts/{account_id}/…
                    │ parse as InstanceId
                    ▼
             查找实例 + 验证权限
                    ▼
          传递已授权的 InstanceContext
```

`account_id` 只是路由占位符的协议名称。handler 立即将其读入 `InstanceId`；下游不接收 `AccountId`，不调用 `cloudflare_account_id()`，不维护 `AccountAuthority` 或 alias table。

为保持已声明的 Wrangler/官方 SDK 合同，`GET /accounts` 的 `result[].id`、`/memberships` 中协议要求的嵌套字段，以及官方客户端的 `account_id` 参数仍由同一对外适配层读写；值仍是原始 InstanceId。这是兼容接口的线格式，不是扩大内部模型。不能为了清理单词而破坏这些已支持的对外响应。`/user`、token verify 同样仅投影已认证的实例与凭证，不创建账户或成员表。

内部配置、CLI 状态、Dashboard 状态、target registry、自有 SDK 的领域模型、数据库、私有 JSON/Cap'n Proto 协议、运行时模板、日志和 metrics 均使用 `instance_id` / `instanceId`。直接调用官方 SDK/Wrangler 的适配代码可以写协议要求的字段，适配前后的内部对象不得存储 account 别名。

格式依据：[Cloudflare Account Details](https://developers.cloudflare.com/api/resources/accounts/methods/get/) 将路径 ID 长度限制为 32；32 位小写十六进制是本项目统一的 InstanceId 格式选择，不再另设“公开格式”。

## 5. 端口、入口与授权

| 入口 | 所有者与分发规则 |
| --- | --- |
| 本地 HTTP，默认 `127.0.0.1:8787` | daemon 只 bind 一次；所有实例共享。可选 admin listener 也只 bind 一次 |
| CF 管理 API | 路径中的原始 InstanceId 定位实例，再验证凭证与该实例、操作权限匹配 |
| 不含 ID 的发现接口 | 由凭证确定实例；不按第一个实例、默认实例或客户端任意 header 兜底 |
| 本地 Worker | `<worker>.<instance_id>.localhost` 按 Host 进入实例的 Worker 路由 |
| Dashboard | 使用实例专属的 `<instance_id>.localhost` 管理 origin；session 和 host-only cookie 均绑定该实例，不设置共享父域 cookie |
| 公网 HTTPS | 一个受监督 Caddy，统一占用所配置的 443；需要 80 时也由它统一管理。按域名进入对应实例 |
| DNS challenge | 一个 daemon 级 UDP/TCP listener，按配置过的 challenge zone 分发 |
| 本机管理 | 一个固定 control socket，CLI 请求携带 InstanceId；不占用每实例管理端口 |
| workerd / binding 后端 | 实例自己的私有 listener；优先沿用 socketpair/Unix socket，现有 TCP 可继续使用自动分配的 loopback 临时端口 |

凭证仍按实例配置。Day1 一个 bearer 凭证只属于一个 `(InstanceId, role)`；注册或修改时拒绝重复凭证，避免发现接口选不出实例。机器管理权限来自受保护的 control socket 及 OS peer 校验，不增加万能 HTTP token。

ID、Host 和路径只负责定位，均不是授权。A 的 token 不能访问 B。上传 token、Git/R2 独立凭证、tail、WebSocket 和无 account 路径的数据面必须各自确定并验证实例，不得遗漏。Host 进入已知 Worker 后只能走 Worker 路由，即使路径是 `/client/v4` 或 `/operator`，也不能变成管理请求。

私有 token/session 绑定实例与运行代次；实例停止或换代后旧能力失效。来自客户端的内部身份 header 必须剥离或覆盖。共享缓存、连接或 registry 只要存在，key 就必须包含实例作用域。

全局 `/health/live` 表示 daemon 存活；全局 ready 表示共享管理/入口能服务。实例 readiness 通过带实例选择的状态接口报告；一个实例 degraded 不应被误当成重启整个 daemon 的信号。日志和聚合 metrics 带 InstanceId，不暴露凭证。

## 6. 数据与运行时所有权

| 机器共享 | 每实例独占 |
| --- | --- |
| daemon 配置清单、全局锁、control socket、入口路由索引、Caddy/TLS/challenge 服务、整机资源 admission | `control.sqlite`、scheduler/log 数据、密钥、业务文件、本地对象根、S3 实例前缀、缓存、调度器、secret crypto、运行时 auth、workerd supervisor、extensions 与 session |

实例数据库本身就是作用域。删除 `accounts` 表及只为多 account 分层设置的恒定字段、索引、外键和查询参数；不要把它们机械改名成每行重复的 `instance_id`。存储对象必须绑定明确的 InstanceContext；不能使用“当前实例”全局变量。

跨实例共享索引、对象存储物理前缀、备份 manifest、密文身份绑定和私有 capability 需要作用域时，使用唯一 InstanceId。secret AAD 和 DO/书签/游标等身份输入同步改造，不能只改数据库字段。原有 Worker、版本、资源间的约束继续保留。

两个实例可使用同一 S3 服务或 bucket，但实际 key prefix 必须按 InstanceId 隔开；不得复用同一个可写对象根。各实例资源配额之外，整机仍需 admission 上限；数据目录不等于磁盘、CPU 或内存配额，daemon OOM 仍是共享故障。

Linux 布局示例：

```text
/var/lib/open-compute/gateway/          # 机器共享持久状态
/srv/dev/compute.toml                  # 实例配置
/srv/dev/data/                         # 实例全部持久数据
/srv/dev/data/runtime/extensions/...   # 实例 Provider 工作目录与 lease
/run/open-compute/control.sock         # 固定机器管理入口
/run/open-compute/i/<instance-id>/     # 短运行目录，存放该实例的 filesystem sockets
```

Unix socket 路径必须满足现有绝对路径与 103 encoded bytes 上限，不能拼接任意 data/cwd/TMPDIR。macOS 使用安装时选定的固定系统运行目录，同样执行长度校验。runtime socket/descriptor 是可重建状态，不需要为了“一个数据目录”塞回持久数据根。

## 7. Native extensions

沿用 W3 的静态配置、facade、`services + props`、socketpair 和受监督 Provider，不改成 `dlopen`，不新增插件注册中心。

**Provider 的所有权是 `(InstanceId, extension_name)`。** 两个实例即使配置相同名字、目录或二进制，也分别启动 Provider；实例内不同 Binding 可继续共享该 Provider，各自保留 session/props。相同扩展名在不同实例不冲突；扩展与 Worker 的名字冲突检查只在所属实例内执行。

每个实例持有自己的 LocalExtensionRegistry、ServiceInvocationRegistry、HostExtensionBroker 和 workerd supervisor。保留现有首次调用启动、清理继承环境、独立进程组、私有 FD、日志限额、lease/start identity、退避、TERM/KILL/reap；已打开的二进制验证规则不变。Broker 只交付授权 session FD，不代理业务 payload，也不让 Provider 绑定公共端口。

停止实例时先停止新调用并撤销能力，终止和回收该实例 workerd/Provider，等任务与文件句柄退出后才释放数据锁。A 的重启和 orphan recovery 不得关闭 B 的 FD、任务、Provider 或 lease。扩展内容修改通过重启所属实例生效，不增加热加载或兼容兜底。

**这是状态、通信和生命周期隔离，不是对不受信任 native code 的 OS 沙箱。** 当前 Provider 与 daemon 权限主体相关，同 UID 下的绝对路径、网络、设备和用户全局缓存不会因不同 cwd 自动隔离。Day1 仅支持 operator 信任的扩展；跨互不信任主体运行 native code 需要独立 OS 权限/沙箱，明确不在本重构范围。访问同一独占设备时允许清晰失败，不建设通用硬件调度器。

## 8. 生命周期与最小实现

将现有 `run_platform(LoadedConfig)` 拆为机器级 daemon composition 与可独立启停的 InstanceRuntime；不是并排调用多次旧 `run_platform`。

机器级只处理一次信号、单例锁、OS service、公共 listener、网关和全局退出。实例级负责加载配置、持有数据锁、构建服务、启动/停止 tasks 与 children，接受自己的取消信号，不自行监听 OS signal，不终止整个进程。

实例状态只需 `stopped → starting → running → stopping`，启动或运行失败记为 `failed`；健康状况单独报告。每实例串行处理生命周期变更。run error 需有界清理，不能丢弃 task handle 后继续称实例已停止。

冷启动先检查所有配置、身份、数据根、凭证和域名冲突；冲突项拒绝启动，不按加载顺序选赢家。全局配置或公共 bind 错误使 daemon 启动失败；单个实例初始化失败仅标记该实例。已有实例运行时加载新实例失败，不影响旧实例。

目标 CLI：

```sh
ocd run --config /etc/open-compute/ocd.toml       # 唯一前台 daemon
ocd start                                      # 启动机器服务，不选择实例
ocd stop                                       # 停止整个 daemon
ocd instances
ocd instance add --config /srv/dev/compute.toml # 更新唯一实例清单并初始化新实例
ocd instance start dev
ocd instance stop dev
ocd instance restart dev
ocd instance remove dev                       # 停止并移出清单，保留配置与数据
```

上述为待实现命令。start/stop 是本次 daemon 生命周期操作；重启 daemon 后按清单的 `autostart` 决定启动。修改配置后显式重启所属实例；公共端口变更重启 daemon。不为任意配置热更新设计 reconcile 引擎。

全机唯一要求一个系统级 service 与固定单例入口；不能继续让不同用户各自启动互不知情的 user daemon。安装时选择受限的非 root 运行用户并配置权限；普通运行不隐式提权。安装、权限和 macOS GUI/TCC 能力需要在对应宿主验证，不能把 launch agent 当作全机单例证明。多个独立容器必须连接同一宿主 daemon；互不共享单例入口的容器不属于“全机唯一”的支持部署。

## 9. 网关与当前方案的关系

P18 的每实例 listener/Caddy 归属由本方案替换：机器管理一套 Caddy 和 ACME 状态；实例只拥有域名声明和业务路由。保留原生多 Caddyfile 能力，但配置入口上移机器级。每实例 base domain 不允许重叠；同一 hostname/zone 的归属必须唯一。

全局 Host 索引从实例配置与各自持久路由权威重建，不再建第二份持久路由库。未知 Host/zone 拒绝路由；停止实例对应流量不可转给其他实例。现有 CNAME、TLS、PROXY peer 和私有 upstream 安全合同继续生效。

Caddy 变更先渲染、校验再应用；失败保留原来的有效配置，不中断其他实例。整机自定义 Caddyfile 是受信任 operator 配置，但与受管域名/listener 冲突仍须在应用前拒绝。不能让实例直接提交全局 Caddy 指令或占用机器端口。

## 10. Day1 与非目标

按仓库 Day1 规则直接替换当前模型。旧 config、路径哈希 ID、独立账户 ID、旧 snapshot/加密/私有协议格式不创建双读双写、alias、fallback 或长期迁移兼容层。不以保留旧公开 account ID 为理由留下派生函数；本次身份 break 需要更新本地 Wrangler/SDK target。

已发布数据库 migration 的文件名、顺序和字节保持不变，当前 schema 通过追加 migration 表达；无法安全接纳的旧状态明确拒绝。历史 migration 中的单词不构成当前内部模型。读取或启动失败不得删除、重置或擅自转换用户数据；另行保留数据/迁移不在本文授权范围。

不新增内部 account/tenant/workspace 三层模型、集群控制面、每实例 OS service、共享 workerd 大池、Provider 池、native marketplace、动态扩展加载或通用跨实例权限系统。

## 11. 实施原则与范围

本次跨 P0/P6/P11/P12/P17/P18/W3 替换身份和所有权模型。删除范围按第 2、4、10 节执行；禁止用 `type AccountId = InstanceId`、废弃别名、私有协议旧字段或运行时 schema fallback 假装完成删除。

批次是开发顺序，不是要发布六套过渡架构。各批次同时更新受影响的生产者、消费者和测试；只有最终单一模型可进入验收。共享 crate 边界沿用仓库现状，不额外建控制平面 framework。

## 12. 按模块修改

| 范围 / 当前入口 | 修改 | 必须删掉或避免 |
| --- | --- | --- |
| `crates/core/src/instance_id.rs`、ID 定义、`config.rs` | 一个可持久化的 32-hex InstanceId；拆出 DaemonConfig 与 InstanceConfig | 路径 SHA/Crockford ID 分配、独立 PlatformId/AccountId、默认账户、实例内公共 bind |
| `crates/storage/src/identity.rs`、`lib.rs`、schema/migrations | 元数据只保留实例身份；存储 owner 绑定实例；产品表依靠独立数据库作用域 | accounts 表、恒定账户列/外键/参数；机械地换成每行恒定 instance_id |
| `crates/storage/src/crypto.rs`、产品 paths、`crates/artifacts/` | 密文、DO key、书签、游标、manifest 与共享对象前缀统一使用 InstanceId；保持授权和完整性约束 | 旧身份查找、旧 AAD 双读、旧前缀 fallback、绕过验证寻找数据 |
| `crates/service/src/run.rs`、`run/startup.rs`、`run/execution.rs` 及其子模块 | 抽出有明确 owner 的 InstanceRuntime；daemon 独占 signal、公共入口和总退出 | 每实例 signal listener、每实例公共 bind、错误时退出整个 daemon |
| `instance_registry.rs`、`instance_control.rs`、`service_manager.rs` | 一份配置清单、一个 control socket、一个机器服务；实例生命周期由 daemon 负责 | 每实例 OS service、路径 digest registry、重复服务状态、跨 HOME 的多个 daemon |
| `http.rs`、`http/state.rs`、`cloudflare_v4/`、各产品 HTTP handler | 外层解析/授权实例，内层使用该实例 HttpState；wire 参数叫 account_id，内部变量/类型叫 InstanceId | AccountAuthority、public_account_id、cloudflare_v4_account、默认实例兜底 |
| Worker/资源/binding API、`crates/workers/`、`packages/runtime/` | 局部调用从 InstanceContext 获得作用域；共享表和私有 capability 显式包含 InstanceId | 私有 account/accountId 字段、只按 Worker 名或扩展名索引的全局可变状态 |
| `host_extension_broker.rs`、`local_extensions.rs`、`service_invocations.rs`、`crates/runtime/` | 每实例 broker/registry/Provider/supervisor；复用既有监督机制 | 跨实例 Provider 去重、共享 session、无身份校验的进程清理 |
| `config/public_gateway.rs`、`gateway_*`、`challenge_dns`、持久路由 | 一个全局网关、一个 DNS listener；每实例声明域名；路由内存索引可重建 | 每实例 Caddy/listener、第二份持久全局路由权威、实例任意注入全局 Caddy |
| CLI、`target_registry.rs`、`target_http.rs`、Wrangler 接线、Dashboard、自有 SDK | 使用 instance_id/instanceId；对外 SDK/Wrangler 调用点才写 account_id；target 指向 endpoint + InstanceId | 同时保存 instance/account 两套值、“默认账户”UI、按配置另起 daemon |
| install / upgrade / uninstall / purge / backup / restore | 安装和升级只管理一个 service；实例移除仅停实例；删除数据保持原有显式确认 | 逐 instance 安装/升级 OS service、卸载时猜测或自动删除实例数据 |
| 运行指南、schema、fixtures、测试注册表 | 源码、维护文档、机器合同、例子一起更新；历史报告仍只代表历史 | 宣称只改单个路径就能完成；保留旧案例迫使生产实现兼容分支 |

`accounts.rs` 可保留为很薄的 CF wire handler 文件，或收敛到兼容模块的实例投影 handler；文件内不能再定义内部账户权威。产品私有 API 不增加一套独立 account 表面。

## 13. 实施顺序

### R1.1 身份和实例存储

- [ ] 定义唯一 InstanceId、格式校验、生成与 `control.sqlite` 权威；metadata 读取与初始化分离。
- [ ] 同步替换独立 PlatformId/AccountId；删除默认 account 和多层身份生成逻辑。
- [ ] 将产品 repository/engine 绑定实例存储；删除实例内恒定账户维度，保留资源、Worker、版本之间的有效约束。
- [ ] 修改文件路径、S3 prefix、secret AAD、DO 身份、书签/游标、snapshot manifest 和私有协议所有对应生产者与消费者。
- [ ] 明确本次格式 break：旧状态不支持时停止，不自动修改、重置或“修复”用户数据。不得保留旧 ID 转换函数。

发布 migration 的字节不可修改。检查本基线已发布的 migration 清单后追加当前 schema 变更；若旧资源状态不能在本次范围内安全接纳，migration 应事务失败并说明需要新目录，不留下部分删除后的数据。对新建库执行完整当前迁移链后仅有一个现行模型。不要仅为了旧开发数据额外设计迁移服务。

### R1.2 配置与全机单例

- [ ] 拆分 DaemonConfig/InstanceConfig；保留现有严格校验、secret 引用与相对路径规则。
- [ ] `ocd.toml` 成为唯一实例清单；CLI 经 daemon 修改清单，写入采用现有原子写与权限检查。
- [ ] 固定机器单例锁和 control socket；任何 daemon 启动入口均先获取同一个锁，不能借更换 config/cwd/HOME 绕过。
- [ ] 替换每实例 systemd/launchd 记录；机器级 service 由安装器配置。开发运行也使用同一单例入口，测试隔离入口仅在 test-support 中注入。
- [ ] 拒绝配置重复、数据根重叠、重复 InstanceId/名字、重复凭证与域名冲突。保留真实 data-dir flock。

### R1.3 InstanceRuntime 与生命周期

- [ ] 重用现有存储 bootstrap、运行时 verify 和 composition，提取可取消的 InstanceRuntime；不平行启动多个旧 `run_platform`。
- [ ] 每实例拥有全部 task handles、workerd supervisor、调度器、后端 listener、auth registry、metrics 和健康状态。
- [ ] signal/daemon shutdown 只在最外层；实例启动/失败/停止均有界清理，不影响其他实例。
- [ ] 同一实例生命周期操作串行化；停止流程先撤路由/新请求，撤销 session，drain/终止 children 与 tasks，最后关闭数据库并释放锁。
- [ ] 进程恢复保留 binary digest、start identity、lease 和 process group 校验，不通过遍历 PID 或 executable 名称杀进程。
- [ ] 共享整机 admission 与每实例预算各司其职，不宣称单数据目录等于硬资源隔离。

### R1.4 统一入口、授权与网关

- [ ] daemon bind 一次公共 HTTP，可选 admin HTTP 同样一次；内部先做 Host 分类，再做所属面的路由。
- [ ] CF 路由读取 account_id 的原始值为 InstanceId，授权后交给实例局部 HttpState。删除全部账户转换/派生。
- [ ] 无路径 ID 的 CF 发现接口由凭证定位；保留受支持的响应形状。未知 ID、越权、缺凭证均返回相应兼容错误，不返回别的实例。
- [ ] 逐项接入 Git、R2、上传 token、tail/WebSocket、Dashboard cookie 和其他非 account 路径入口；不能只改 REST /accounts 路径。
- [ ] 本地域名用唯一 InstanceId；保留 Worker-host-first 和内部 header 防伪。共享 cache key 显式含实例作用域。
- [ ] Caddy/TLS/challenge DNS 升到 daemon；保留 P18 的域名归属、CNAME、peer trust、私有 socket 和验证后 reload。
- [ ] 域名/zone 所有权索引只由各实例权威投影；停实例不允许流量 fallback，配置失败保留其他实例的有效网关。

### R1.5 扩展、CLI 和工具链

- [ ] Provider 以 `(InstanceId, extension_name)` 为所有权；同 binary、同名字也不跨实例共进程。
- [ ] 实例独占 extension/binding/session registry；Binding props 不变；native 权限仍是受信任 operator 边界。
- [ ] CLI 区分 daemon 和 instance 生命周期；`instance remove` 保留配置/数据；purge、restore 与卸载不扩大破坏权限。
- [ ] target 状态只存 InstanceId；自有 SDK/Dashboard 内部只用实例名称；调用官方 SDK/Wrangler 时才填线格式 account_id。
- [ ] 升级只替换一次 daemon executable、重启一次机器 service，由 daemon 恢复所有 autostart 实例。
- [ ] 核查私有 runtime schema/模板。只有确实涉及原生 seam 变更才修改正式 fork，并按既有 pin/build/Gate 规则同步，不能假设旧二进制已支持新协议。

### R1.6 清理、文档与一次验收

- [ ] 删除被替代的旧实现、无效参数和测试，更新源合同及生成输入；不手改生成文件。
- [ ] 更新维护文档、CLI/安装示例和 docs 索引；将 AGENTS 的“一个平台/一个 workerd”表述更新为 daemon/instance 所有权。当前文档阶段不提前改写已实现事实。
- [ ] 新 Gate cases 注册到现有 case inventory，无另起重复 suite、跳过不支持的旧断言或放宽成功条件。
- [ ] 静态检查与 coverage 后，最终 `./test/gate.py --workspace` 只跑一个完整轮次；记录真实结果。

## 14. 必须通过的回归

所有断言要求同时运行 A/B，刻意使用相同 Worker/资源/扩展名，并在需要验证共享 key 时注入可碰撞的局部 ID。不要只用永不重复的随机名称掩盖作用域问题。

| 编号 | 必须证明 |
| --- | --- |
| R1-T01 全机单例 | 两个不同 config/cwd/HOME 启动，只有一个 daemon 获得机器锁；第二次启动失败且不破坏原 control socket。跨 OS 用户需真实宿主资格，不以 unit test 冒充 |
| R1-T02 唯一身份 | 新目录初始化一次；重启、移动配置并保持原数据路径、搬迁完整数据不变 ID；损坏身份不重建；只有一种 32-hex 对外表示 |
| R1-T03 重复与锁 | 同目录、父子目录、两目录同 ID、两份配置引用同实例均拒绝；真实离线工具仍拿不到运行中实例的数据锁 |
| R1-T04 CF 原样 ID | `/accounts/{id}`、列表响应、target 与内部 InstanceId 完全同值；无哈希/别名转换；受支持 Wrangler 工作流可部署到指定实例 |
| R1-T05 凭证 | A token 不能读写 B；重复凭证拒绝；无 ID 发现只返回授权实例；无凭证不得枚举全机实例 |
| R1-T06 Host 隔离 | A/B 同名 Worker 可同时服务；未知 Host 拒绝；Worker 上的 `/client/v4`、`/operator` 不进入管理面；伪造内部 header 无效 |
| R1-T07 存储 | 同名 KV/R2/D1/Queue/DO 等互不读写；对象 key/S3 prefix 隔离；不通过切换一个全局“当前实例”实现 |
| R1-T08 密文与备份 | A 密文/书签/能力不能在 B 使用；新格式重启可读；不支持的旧格式拒绝且原数据保留；备份、restore 身份校验一致 |
| R1-T09 独立启停 | 重启或停止 A 后 B 请求持续完成；A 的启动失败不终止 B；A 数据锁只在任务、children 和存储都退出后释放 |
| R1-T10 实例与 daemon 恢复 | crash/restart 不遗留 children、listener 或有效旧 token；一个实例恢复不能误杀另一个实例；daemon 重启只恢复清单中的 autostart |
| R1-T11 Provider 隔离 | A/B 相同扩展名和二进制有不同 Provider PID/cwd/lease；实例内多 Binding 的既有共享语义不变 |
| R1-T12 Session 隔离 | A 的 generation/session/FD 不能 attach B；A 停止撤销能力；迟到 ACK、旧代次和断连 fail closed |
| R1-T13 Provider 故障 | A Provider crash/backoff/熔断不影响 B；停止 A 只清理 A 的进程组；native 副作用不被自动重放 |
| R1-T14 共享网关 | 全部实例只启动一个 Caddy 和一个 challenge listener；多域名正确归属；重复/重叠域名和 Caddyfile 冲突拒绝 |
| R1-T15 网关失败 | 新配置验证失败保留已有服务；停 A 不把 A 域名路由给 B；未知 challenge zone 不被授权；真实 TLS/DNS 另行资格记录 |
| R1-T16 Socket/端口 | filesystem Unix socket 最长路径规则保持；长 config/data path 不进入 socket 路径；内部端口自动分配且 loopback-only |
| R1-T17 非 REST 表面 | Git/R2 独立凭证、上传 token、tail/WebSocket、Dashboard login/cookie 均正确选择和隔离实例 |
| R1-T18 运维与权限 | 一次安装/升级只管理一个 service；remove 不删数据；未知归属/运行中数据的 purge 拒绝；status 不写 DB、不泄露秘密 |
| R1-T19 资源与观测 | 整机上限确实约束多实例总负载；实例限额仍有效；metrics/log 作用域正确，单实例 degraded 不触发整机重启 |

## 15. account 残留检查

生产源码应人工核查以下结果，并将精确的协议边界约束接入已有 boundary check，而不是整目录大范围豁免。

```sh
rg -n 'AccountId|PlatformId|AccountAuthority|default_account_id|public_account_id|cloudflare_account_id|cloudflare_v4_account|digest_canonical_config_path' crates packages apps
rg -n '\b(account_id|accountId|accountID|platform_id|platformId)\b' crates packages apps
rg -n '\baccounts\b' crates packages apps
```

以上为待实施仓库检查命令，不是本次已运行的结果。

允许保留：CF 路由、响应字段/DTO、官方 SDK/Wrangler 请求边界、对应协议测试，以及不得修改的已发布 migration 文本。它们不允许承载账户权威或生成第二个 ID。禁止简单豁免整个 `cloudflare_v4/`、SDK 或 migrations 目录来藏现行内部账户代码。

内部业务参数、存储/配置字段、私有 runtime 数据、UI 状态和自有 DTO 不在允许范围。OS 用户解析不属于产品账户模型，但变量/函数也应明确叫 `uid`/`gid`/`service_user`，不混用产品的 `account_id`。

## 16. 验证与交付

文档阶段只验证 Markdown、TOML 示例、路径、索引、patch 与 `git diff --check`；不要求构建 Rust，不下载 Git LFS runtime，不宣称产品 Gate 通过。

实施阶段使用仓库现有入口，执行权限遵守 AGENTS：

```sh
# 先准备已授权、正式 pin 的现有构建输入，再执行：
bun run build
cargo fmt --all --check
./test/check-rust-clippy.sh
RUSTFLAGS='-D warnings' cargo check --workspace --no-default-features
cargo +1.98.0 check --workspace --all-targets
cargo metadata --no-deps --format-version 1
./test/check-boundaries.sh
./test/coverage.sh
./test/gate.py --workspace
```

保留 Rust 行覆盖率至少 90.00% 的当前门槛，不使用多轮重跑掩盖时序问题。真实多用户 service、macOS GUI/TCC、低端口、公网 DNS/ACME 和受特权控制的测试逐项取得授权并记录；没有证据时标记未验证，不宣称全平台完成。

实现完成后按文档生命周期精简并移动 R1 结果，移除本文的实施过程、完成 TODO 与测试矩阵，只保留用户结果、持久边界、实际证据和接受的限制；不另留过渡架构副本。

## 17. 源码依据

以下是审阅基线的当前事实，不是目标已实现的证明；相对链接指向对应实现入口。

| 当前事实 | 来源 |
| --- | --- |
| Instance ID 来自配置路径；registry 还保存服务与配置信息 | [instance_id.rs](../crates/core/src/instance_id.rs)、[instance_registry.rs](../crates/service/src/instance_registry.rs) |
| 数据另存 platform/default account 身份；公开 ID 再派生 | [identity.rs](../crates/storage/src/identity.rs)、[accounts.rs](../crates/service/src/cloudflare_v4/accounts.rs) |
| 配置和 run composition 同时拥有实例与机器资源 | [config.rs](../crates/core/src/config.rs)、[run.rs](../crates/service/src/run.rs)、[execution.rs](../crates/service/src/run/execution.rs) |
| 数据路径、密文和资源访问已经使用旧 account 作用域 | [data_dir.rs](../crates/storage/src/data_dir.rs)、[crypto.rs](../crates/storage/src/crypto.rs)、[d1.rs](../crates/workers/src/d1.rs) |
| Native Provider 已有独立进程、socketpair 和 lease | [host_extension_broker.rs](../crates/service/src/host_extension_broker.rs)、[persistent_process.rs](../crates/runtime/src/persistent_process.rs)、[W3](implemented/w3-user-extensible-native-bindings.md) |
| Day1、发布 migration 不可变、短 Unix socket 和文档验证规则 | [AGENTS.md](../AGENTS.md)、[文档规则](references/README.md) |

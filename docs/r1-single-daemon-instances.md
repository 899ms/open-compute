# R1：单 OCD daemon、多 Instance 与单一身份重构

状态：**planned**。2026-09-22。审阅基线：`d66e41e8b996cce8471c795fdefaa3ce8fe9e149`。
本文定义目标合同、实施原则与验收要求；代码尚未实施。按 Day1 直接替换当前模型，不维护旧 open-compute 的布局、配置或身份兼容路径。

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

路径按规范化后的真实文件系统关系、owner、no-follow 与 containment 规则检查；不能只比较字符串前缀。`instances-old/` 不属于允许子树，`..` 或 symlink 也不能绕过校验。新目录检查已有父级并在创建后复验。setup、add、启动、purge 和 restore 都遵守同一边界；不以递归 chown 或删除自动修复未知目录。

### 2.2 Socket 和临时运行状态

具名 Unix socket 全部在 `<OCD_DIR>/run/`，实例子路径以 InstanceId 区分；内部优先使用无路径的 socketpair。具名 socket 在 bind/connect/配置渲染前检查绝对路径及 **103 encoded bytes** 上限，采用短文件名；超长明确报错，不外置到 `/tmp` 或建立备用运行根。外置实例目录再长也不进入 socket 路径。

run 中的 descriptor/socket 可重建，但只能由持锁的 owner 在完成对应旧子进程身份核验与恢复后处理；不把 run 或 lease 交给通用 temp/cache 清理。

## 3. 全局清单指向配置，实例配置指定数据

### 3.1 `<OCD_DIR>/ocd.toml`

以下是目标配置示意，不代表当前二进制已支持：

```toml
[server]
public_bind = "127.0.0.1:8787"
# 需要时显式配置 admin_bind；默认只在 loopback 合并入口。

[[instances]]
config = "./instances/dev/compute.toml"
autostart = true

[[instances]]
config = "/projects/production/compute.toml"
autostart = true
```

清单只保留 `config` 与 `autostart`；`config` 唯一决定读取哪份实例配置，不复制其中的 data 路径、InstanceId、digest、PID 或服务状态。不另建 registry/全局实例数据库，不通过扫描 `instances/` 建立清单。内存索引从显式配置及实例权威重建。

共享 listener、Caddyfile 列表、challenge DNS、代理信任、全局 cache 策略及第 10 节列明的共享上限由本文件配置；不再配置 `daemon.state_dir`。本文件的相对路径相对 OCD_DIR。CLI 中显式输入的相对文件系统路径先相对 CLI cwd 解析，再写成与目标配置位置一致的路径值，不能依赖 daemon cwd。

### 3.2 实例的 `compute.toml`

```toml
[instance]
name = "dev"

[data]
path = "./data"

[extensions.local-files]
path = "./extensions/files"
```

**`[data].path` 是必填的唯一数据根配置，支持绝对路径或相对本配置文件的路径；缺失即报错。**上例若位于 `<OCD_DIR>/instances/dev/compute.toml`，数据为 `<OCD_DIR>/instances/dev/data/`；同一配置位于 `/projects/dev/compute.toml` 时，数据为 `/projects/dev/data/`。也可直接指定 `path = "/mnt/data/dev"`，与配置是否位于默认目录无关。

运行时从明确的配置路径加载文件，再解析 `[data].path`；不反过来从数据目录寻找配置，不把配置父目录当作数据根，不保留全局清单的 `data_dir` 字段或旧全局数据根默认值。密钥、本地对象、cache、tmp 和恢复状态由解析出的 INSTANCE_DIR 派生，其他 data 策略字段保留。

认证、存储 backend、KV/R2/D1、AI、调度、实例限额及域名声明留在实例配置；不包含公共监听端口、OS service scope 或另一份账户/平台身份。secret 继续采用经过校验的 env/file 引用，OCD 生成的 secret 只写在该实例数据根下；配置仅保存引用。

本配置中所有相对文件路径（含 data、extension、secret 引用）都相对 `compute.toml` 所在目录解析，不相对 data 根。扩展只静态声明；跨配置不做隐式继承、层层 merge、旧配置发现或损坏时 fallback。移动配置时必须保持解析后的数据路径不变或显式更新它，不能承诺移动任意相对路径配置就自动找到原数据。

## 4. 唯一身份与 Cloudflare 边界

`InstanceId` 在新实例初始化时生成一次，持久化到 `control.sqlite` 的实例元数据，统一表示为 32 位小写十六进制字符串。可用 UUID v7 的无连字符形式生成；配置和目录名不产生身份。

重启、搬迁完整实例目录不改变 ID。已有状态身份缺失、重复、损坏或 schema 不支持时拒绝启动，不生成新 ID“修复”。status 只读，不初始化数据。复制完整目录不会创建新身份；本阶段不提供资源重写式 clone。

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

account 命名只属于 Cloudflare 对外线协议：包括上述路径、已支持的 `/accounts` 列表、`/memberships` 必需字段和官方 SDK/Wrangler 调用参数。`/user`、token verify 等由已认证实例和凭证投影，不建立内部账户、用户或成员实体。内部自有 DTO 不保存 account 别名。官方 [Account Details](https://developers.cloudflare.com/api/resources/accounts/methods/get/) 要求路径 ID 长度为 32；小写十六进制是本项目的统一格式选择。

删除 AccountAuthority 不等于删除其他资源的协议行为：KV/D1/DO、Queue、consumer ID、Worker tag 等按各自当前官方合同输出和解析。资源自身 ID 已满足格式时直接使用；确需序列化投影时只在 CF 适配边界使用无状态纯函数。不保留旧 open-compute 的哈希输出，不新建有状态 projector、映射表或第二套权威；必须验证资源查询/引用往返及 Wrangler 的受支持流程。

实例数据库天然提供作用域，删除只为账户层存在的恒定列、外键、索引和查询参数，不机械改成每行重复的 instance_id。跨实例共享 key、S3 前缀、备份 manifest、密文 AAD、DO/书签/游标和 capability 需要作用域时使用唯一 InstanceId；资源、Worker 和版本之间的有效约束继续保留。

## 5. 本机权限与配置修改

OCD_DIR、INSTANCE_DIR 及其私有子目录由确定的非 root 运行 UID 持有，目录默认 `0700`；配置（含外置 compute.toml）、secret、descriptor、管理 socket 默认 `0600`。外置配置仅校验并访问已明确授权的文件，不递归接管其项目目录。系统 setup 只在安装阶段创建系统目录/注册服务并赋予该运行用户所有权，系统模式下的 `ocd.toml` 也不是 root-only `/etc` 配置。

管理 socket 只接受 **运行 UID 或 root**，无额外允许 GID、admin group、ACL 或本机角色系统。普通同 UID CLI 可直接使用；root 是显式管理通道，不是默认运行要求。Linux 使用真实 `SO_PEERCRED`，macOS 使用真实 `getpeereid`/等价内核 peer API；读取失败拒绝，禁止返回自身 UID 伪装成 peer 验证。客户端也校验目标路径及服务身份，不向错误 owner 的 socket 发送管理信息。平台接口依据见 [Linux unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html) 和 [Apple getpeereid](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/getpeereid.3.html)。

在线实例增删通过管理 socket，由 daemon 串行校验并原子改写唯一 `ocd.toml`；写入采用 no-follow、owner/mode、fsync/atomic rename。实例 HTTP admin/deployer 凭证没有此权限，网络请求不能改全局配置或指定 native executable。运行 UID 及其配置的 native 扩展属于同一受信任主体，不声称网络 daemon 被攻破后仍有独立的同 UID 配置隔离。

校验失败不写清单；清单成功落盘后运行失败则保留明确的 failed 状态和原因，不回滚删除数据。手工配置修改只在显式重读/相应重启后生效；与在线修改发现内容冲突时拒绝覆盖。停止 daemon 时可由 owner 编辑文件，不另设离线写入 daemon 或持久 registry。

## 6. 公共入口与共享 Gateway

| 入口 | 规则 |
| --- | --- |
| 本地 HTTP / 可选 admin HTTP | 每个 daemon 各 bind 一次，默认 loopback；不为每实例分配公共端口 |
| CF 管理 API | 原始 InstanceId 定位实例，再验证实例和操作权限 |
| 无路径 ID 的发现接口 | 一个 bearer 只对应一个 `(InstanceId, role)`；拒绝重复凭证；无权限不得枚举其他实例 |
| 本地 Worker | `<worker>.<instance_id>.localhost`；Host 先分类，Worker 的管理样式路径不进入管理面 |
| Dashboard | `<instance_id>.localhost` 管理 origin；host-only cookie 和 session 绑定实例，不设置共享父域 cookie |
| 公网 Gateway | 一套受监督 Caddy 管配置的 HTTPS/可选 HTTP 端口；按域名分发，不把实例管理入口自动公开 |
| DNS challenge | 一个 UDP/TCP listener，仅处理已声明的 challenge zone |
| 内部通信 | socketpair 或 OCD_DIR/run 内的私有 socket；保留必要的自动分配 loopback TCP 端口，不暴露给用户配置 |

ID、Host、路径均不代表授权。Git/R2 独立凭证、上传 token、tail/WebSocket、Dashboard 和其他非 `/accounts` 入口也必须定位并验证实例。移除/覆盖伪造内部 header；共享索引和会话以实例和运行代次隔离，停止后旧能力失效。

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

持久 start/stop 意图仅由清单 autostart 决定，单次 start/stop 不隐式改 autostart。配置改变后显式重启所属实例；公共端口和作用域变更重启对应 daemon。修改 `[data].path` 不自动移动数据；必须先停止原实例并重新验证新目标，不把新目录冒充原实例身份。实例增删只影响相关实例，不实现通用 reconcile 引擎。

安装、升级和卸载每次只管理选定作用域的一套 OS service，默认保留实例数据。移除、purge、restore、全局卸载严格区分；purge 仍需原有显式确认和路径归属证明，不能因为默认实例嵌在 OCD_DIR 下就递归删除全部目录。

### 9.1 交互式创建实例

已核对当前 CLI：顶层 `ocd setup` 已有交互式配置创建，会询问配置路径、数据路径等，并与独立 OS service 的安装耦合；`ocd instance` 目前只有 unregister，没有独立的交互式创建入口。R1 必须补 `ocd instance setup`，复用现有提示与配置生成能力，不把每实例 OS service 带进新模型；本段是待实施合同。

`ocd setup` 负责选定作用域的 daemon 安装/初始化；首次 setup 创建首个实例时复用下列同一流程。`ocd instance setup` 只向已经运行的选定 daemon 添加实例，不再安装服务、不隐式提权；daemon 未运行时明确提示先启动。

向导依次收集可选显示名、配置文件路径、数据目录、是否 autostart、是否立即启动；最后展示规范化后的配置/数据路径、作用域与启动选择，确认后才创建文件或修改清单。数据目录提示展示最终绝对路径，不让用户猜测相对基准。默认配置落点可建议 `<OCD_DIR>/instances/dev/compute.toml`，默认数据可建议该配置旁的 `data/`；两项均可独立修改，目录名不成为实例身份。

向导生成的 `compute.toml` 必须显式写入 `[data].path`；采用默认布局时可写 `./data`，用户选择外置目录时写入等义的明确路径。写入后的路径解析结果必须与最终预览一致。默认目录建议只发生在创建时；加载手写配置或 `instance add` 时缺失 data 字段直接拒绝，不能复用向导默认值兜底。

`--config`、`--data-dir`、`--name` 可预填输入；`--yes` 接受明示默认值并跳过交互，但不跳过路径、权限、唯一性及已有文件检查。可用 `--autostart=false` 与 `--start=false` 明确拒绝相应默认启动选择。未提供名称和配置路径时可建议 `instances/default/compute.toml`；已占用就报冲突/要求另选，不自动覆盖或复用已有实例。非 TTY 且无 `--yes` 时在写入前拒绝；取消同样不落盘。

CLI 收集输入和确认，daemon 经已授权管理 socket 串行执行校验、独占创建配置/secret、初始化明确的新数据状态并登记 `config + autostart`。生成文件由 daemon 的运行 UID 持有；配置只含 secret 引用，输出不打印凭证。已有配置交给 `ocd instance add --config ...`：读取其原始 `[data].path`，不覆盖配置或改变数据路径。两条入口共用配置加载、目录边界、身份初始化和登记逻辑；`add` 不是创建向导的旧命令别名。

创建拒绝覆盖配置、secret 或接管非本平台的非空数据目录；`--yes` 不是删除/重置授权。失败回滚只能移除本次确定创建且尚未成为持久权威的文件；已初始化的数据或已尝试启动的实例保留并报告错误。两份配置指向同一数据根、重复 ID/名称、非法目录等冲突在登记和启动前检查；任何一步不得留下指向不存在配置的有效清单项。

## 10. 有边界的共享资源限制

不承诺通用的“整机总负载保证”。R1 只将以下已有计数器上移到同一 daemon 共享服务，目标配置项均在 ocd.toml；不在每实例重复一份相同共享上限：

| 配置项 | 单位、默认值 | 获取/释放与超限行为 |
| --- | --- | --- |
| `artifacts.max_concurrent_requests` | 同时在途的 Git 请求数，16 | 所有实例共享同一 semaphore；开始读取/处理 Git body 前 try-acquire，请求/流结束或错误取消释放；无额度拒绝新 Git 请求，不建无界队列 |
| `metrics.max_series` | daemon 保留的不同 metric series 总数，1024 | 包含 InstanceId 标签后的实际 series 统一计数；新增注册前检查，删除 series 时释放；到上限拒绝新增 series 并有界报告，不驱逐现有 series 或重启 daemon |

Git 超限沿用产品已声明的限流错误；metric 容量不足不能导致进程崩溃。全局/实例 cache 另按第 8 节限制。产品数据库、Worker/资源数、解析并发等仍按实例现有策略执行，不为了 R1 新建通用调度、公平分配、CPU/RSS 聚合配额或跨文件系统磁盘预算框架；现有磁盘低水位与写入保护不删除。

全局 `/health/live` 表示 daemon 存活，ready 表示共享入口可服务；实例 readiness 单独报告。日志/业务 metrics 以 InstanceId 区分，单实例 degraded 不触发全 daemon 重启。资源回归只验证本节两个明确计数器及已有实例限制，不以一次压测宣称硬资源隔离。

## 11. 备份、恢复与共享状态归属

实例数据备份以 `[data].path` 解析后的 INSTANCE_DIR 为边界，保护身份、密钥及业务持久数据。`compute.toml` 可能位于数据根之外，由 operator 按清单里的实际配置路径另行一并备份，不假称复制数据目录就包含配置；默认 instances 布局也遵守同一规则。远端对象仍按产品备份合同处理，不能假称本地副本包含 S3。实例 cache/tmp 和具名 socket 不进入备份，可重建工具副本不要求备份；实例备份不包含全局 Gateway。

**共享状态由 operator 独立备份，R1 不新增机器备份引擎。**备份范围包括 OCD_DIR/ocd.toml、全局必需 secret、Gateway 的证书/ACME storage 与已生效配置，以及引用的 operator 配置输入。缓存、临时 challenge TXT、socket、PID/运行 lease 不作为恢复输入；外部输入需 operator 自行一并保护。全局备份不递归吞入默认 instances，避免混淆实例备份归属；secret 备份保持私有权限，不进日志或 support bundle。

本阶段的整机冷恢复顺序固定为：停止 daemon 及全部 children → 恢复全局配置/Gateway 持久状态与权限 → 恢复各实例 compute.toml、数据目录及对应远端数据 → 核对配置路径、data 路径、ID/冲突 → 启动 daemon。配置搬迁时 operator 更新全局清单的 config；数据搬迁时更新对应 compute.toml 的 `[data].path` 并复验相对引用，不通过旧路径搜索自动兜底。

已初始化 Gateway 的证书/ACME storage 丢失时拒绝自动批量重签；全新 setup 与状态丢失必须区分，恢复备份或由 operator 明确重新初始化。实例恢复不得覆盖共享 Gateway；global cache clean、instance purge 和目录权限处理都不得触碰证书及其他实例。

## 12. Day1 实施原则

本次只保留一个现行模型：同一作用域单 daemon、唯一 InstanceId、两类数据根、显式 config → `[data].path` 加载链。旧 config/state/cache/runtime 路径、路径哈希 ID、账户别名、旧 API 私有字段、旧 AAD/snapshot/hash 输出不保留读写分支、backfill、alias、fallback 或迁移服务。唯一协议兼容义务是项目明确支持的官方 Cloudflare 行为，不是旧 open-compute 实现。

已发布数据库 migration 的文件名、顺序和字节不可修改；需要改变当前 schema 时追加 migration。不能安全接纳的旧状态明确拒绝并保留原数据，不在启动、setup 或清理中自动重置。新目录执行完整当前迁移链后只有一个现行模型；不为了旧开发数据保留账户层。

实施按职责闭环推进，不按预先枚举的文件名单判断完成：

- [ ] 身份/存储：统一实例权威，删除账户维度，同步所有路径、密文、资源引用和私有协议的生产者与消费者。
- [ ] 目录/权限：固定两类根与显式 config/data 职责；instances 只作创建默认值；保留用户级体验，统一路径包含检查、owner/mode、真实 peer 校验、同一清单写入与作用域单例。
- [ ] 生命周期/入口：独立 InstanceRuntime、共享 listener/Gateway、全部入口授权、跨实例隔离与子进程恢复同时接通。
- [ ] 清理/备份/工具：补独立 instance setup 向导并复用创建能力，登记既有 config；同步 cache/temp 回收、CLI cache clean、外置配置/共享状态备份、安装/升级/purge/restore 和 SDK/Dashboard 引用。
- [ ] 收尾：删除旧实现和无效参数，同步维护合同、生成输入、例子和测试；完成对应静态检查、coverage 与一次最终 Gate。

以上是开发顺序，不是发布多套过渡架构。涉及正式 workerd 私有 seam 时同步 fork、pin 和验证，不假设旧二进制支持新协议。实现期间同步替换 AGENTS/维护文档中旧的单实例、外置 runtime 路径等规则；本文仍为 planned，不提前把当前实现标成新模型已完成。

账户残留检查覆盖生产领域类型、配置、数据库、私有 runtime 数据、SDK/UI 状态和全部调用边界，不以某个目录豁免代替检查。允许的 account 词只在 CF wire 参数/DTO/相应协议测试及不可改写的已发布 migration 中；不得藏入第二个身份权威。OS 用户变量明确命名为 uid/gid/service_user。默认 root、旧路径发现、外部临时目录、全局清单的 data_dir 副本及按目录推断 data 的行为也需同样清除；这不包括必须保留的实例 `[data].path`。

## 13. 回归与交付

跨实例场景同时运行 A/B，刻意使用相同 Worker/资源/扩展名，并在共享 key 测试中注入可碰撞的局部 ID。以下是待实现断言，不是已通过结果；复用现有 Gate/case inventory，不新增重复 suite。

| 编号 | 必须证明 |
| --- | --- |
| R1-T01 作用域与安装 | 默认 setup/CLI 不用 root；显式 system setup 后 daemon 仍为原非 root 用户；同一 OCD_DIR 只有一个持锁 daemon，改 cwd/HOME 不创建另一用户根，重复启动不破坏原 socket；不同 scope 无隐式 fallback |
| R1-T02 唯一身份 | 初始化一次、重启/搬迁数据不变 ID；移动配置且保持 data 指向时不变 ID；改 data 路径不自动迁移/删原数据；损坏身份不重建；名称变更不影响引用；无名称实例可管理；内外 ID 同值 |
| R1-T03 目录边界 | data 在 instances 严格子目录或完全外置合法；OCD_DIR 本身、instances 本身、任意非 instances 子树（含 custom/instances-old）、父目录重叠、实例互嵌、重复配置/数据根/ID、symlink/.. 逃逸及独立 object root 拒绝；purge/restore 不碰其他 owner |
| R1-T04 CF 线协议 | account_id 原样使用 InstanceId；列表/成员等支持面仍可用；资源 ID、Queue/consumer、Worker tag 的查询引用往返和正式 Wrangler 部署通过，无旧 hash 兼容 |
| R1-T05 HTTP 凭证 | A token 无法操作/枚举 B；重复凭证拒绝；无 ID 发现只选择授权实例；HTTP admin 无权改 ocd.toml 或扩展路径 |
| R1-T06 Host 隔离 | 同名 Worker 同时服务；未知 Host 拒绝；Worker 的管理样式路径不进入管理面；伪造内部 header 无效 |
| R1-T07 数据隔离 | KV/R2/D1/Queue/DO 等同名资源互不读写；S3 key prefix 隔离；无全局当前实例切换 |
| R1-T08 密文与备份 | 跨实例密文/书签/capability 拒绝；新格式重启可读；旧格式拒绝且不删原数据；外置 compute.toml 与 data 的备份归属和恢复路径明确，默认目录没有另套规则；restore 身份一致 |
| R1-T09 独立启停 | A 重启/启动失败不终止 B；停止先撤入口并收回 tasks/children，最后才释放存储锁 |
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

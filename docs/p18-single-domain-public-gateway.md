# P18：单域名公网网关、DNS 与 TLS

状态：Day 1 单基础域名、固定产品 namespace、手工 DNS onboarding、内嵌 Caddy、DNS-01 wildcard TLS 与
`ocd` Host 路由合同完成；待实现 pinned Caddy、自有 DNS provider、权威 challenge DNS、持久化 authority、
Worker/R2 公网入口与真实 DNS/ACME 验收。

P18 为一个 self-hosted open-compute 实例接入一个 operator 控制的专用基础域名，并为 Worker、R2 以及以后明确支持
公网访问的产品生成稳定 HTTPS URL。设计聚焦单个专用 `base_domain` 和固定产品 namespace。operator 一次性手工配置业务
wildcard DNS 和 ACME challenge DNS；之后创建、删除资源和证书续期均由 open-compute 自动完成。

P18 遵循 [Host authority](references/host-authority.md)，复用先行的
[R0 Worker `.localhost` Origin 重构](r0-localhost-worker-origins.md)建立的 Host-first ingress、hostname claim、typed product route
和 origin endpoint API；Caddy lifecycle 复用 [P17 宿主子进程管理基础设施](p17-host-process-infrastructure.md)。R0 本机 origin
不依赖 P18；P18 只增加可选的公网 DNS、HTTPS 与 public-name 生命周期。

## 1. 范围与结论

P18 Day 1 固定以下合同：

- 每个实例恰好配置一个 `base_domain`；
- `base_domain` 可以是专用 registrable apex，例如 `ocd.com`，也可以是已有业务 zone 下专门划出的固定子域，例如
  `compute.example.com`；
- Worker 使用 `<name>.<base_domain>`，其他公开产品使用 `<name>.<product>.<base_domain>`；
- account 仍是持久化、授权和隔离边界，公网 URL 使用独立的产品 namespace；
- 每个启用的产品 namespace 只有一条 wildcard DNS 和一张 wildcard certificate；
- 创建、部署、重命名或删除单个资源只更新 SQLite hostname binding，并复用现有 DNS、证书和 Caddy 配置；
- wildcard certificate 通过 ACME DNS-01 申请和续期，namespace 内全部资源共享该证书；
- `ocd` 内嵌并监督一个正式 pin 的定制 Caddy child；Caddy 是唯一 TLS/certificate owner；
- 用户继续管理普通 DNS zone，open-compute 为被委派的 `_acme-challenge` 名称提供最小权威 DNS；
- 同一套运行时同时支持 ocd 直接接收公网流量，以及现有四层代理按 SNI passthrough 到 ocd，并共享同一证书状态机；
- `ocd` 是 hostname、account、产品资源和 deployment 的唯一路由 authority；Caddy 只处理固定 namespace、TLS 和反向代理；
- 正式 release 仍只有一个 native `ocd` 文件。Caddy 像 workerd 一样作为经过校验的内嵌 payload 离线物化。

核心结构：

```text
operator-owned DNS zone
  ingress.<base_domain>               A/AAAA -> public gateway address
  *.<base_domain>                     CNAME  -> ingress.<base_domain>
  *.r2.<base_domain>                  CNAME  -> ingress.<base_domain>
  ns1.<base_domain>                   A/AAAA -> public challenge DNS address
  _acme-challenge.<base_domain>       NS     -> ns1.<base_domain>
  _acme-challenge.r2.<base_domain>    NS     -> ns1.<base_domain>
                  |
                  +-- TCP 443 ------------------------------+
                  |   direct or existing L4/SNI passthrough |
                  |                                         v
                  |                                 pinned Caddy child
                  |                                 - wildcard TLS
                  |                                 - ACME renewal
                  |                                 - reverse proxy
                  |                                         |
                  |                                         v
                  |                                 private ocd listener
                  |                                 exact Host -> target
                  |
                  +-- UDP/TCP 53 -> ocd challenge DNS
                                      - authoritative only
                                      - SOA/NS/TXT only
                                      - no recursion
```

Day 1 公网合同使用 TCP 443 提供 HTTP/1.1 与 HTTP/2，并使用 UDP/TCP 53 提供 challenge DNS。

## 2. 设计依据

Cloudflare 的 [`workers.dev`](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) 展示了资源创建后立即获得
稳定 URL 的产品体验。P18 在 operator 提供的专用 namespace 上实现相同的日常资源工作流。

[Let's Encrypt challenge 文档](https://letsencrypt.org/docs/challenge-types/)明确：wildcard certificate 必须使用 DNS-01；
DNS-01 查询可以通过 `NS` 或 `CNAME` 委派给独立 challenge DNS。P18 采用 `NS` 直接委派固定 challenge 名称，使证书自动化
保持 provider-neutral。

[Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https) 已负责 ACME account、证书签发、持久化和后台续期；
[Caddy wildcard 配置](https://caddyserver.com/docs/caddyfile/patterns#wildcard-certificates)要求 DNS challenge provider。
P18 使用 Caddy 的原生 JSON 配置和一个编译期自有 provider，由 Caddy 统一管理 ACME/certificate lifecycle。

[`caddy-dns/cloudflare`](https://github.com/caddy-dns/cloudflare/blob/master/cloudflare.go) 提供了合适的薄适配结构参考：注册
`dns.providers.*` Caddy module、实现 `Provision`，并通过 libdns record append/delete 接入 Caddy 的 DNS-01 生命周期。
P18 沿用这一模块边界，在 provider 内连接 ocd 的本地 challenge authority。

## 3. 单基础域名与 URL

### 3.1 接受的域名

以下两种配置等价：

```text
dedicated apex:       ocd.com
dedicated subdomain:  compute.example.com
```

`base_domain` 必须：

- 是 canonical ASCII hostname；输入去除末尾 dot、转小写并按 IDNA 转成 A-label；
- 不是 URL、IP literal、wildcard、localhost、public suffix 或带 port/path/query/fragment 的值；
- 至少包含一个 registrable domain；
- 是 operator 明确划给当前 open-compute 实例的独占 namespace。

一个实例只有一个 active `base_domain`。域名替换 workflow 先停用当前公网 namespace 和 binding，再为新域名完成 DNS、证书和
binding onboarding。

### 3.2 固定 namespace

| 产品 | URL | DNS/certificate namespace |
| --- | --- | --- |
| Worker | `<public-name>.<base_domain>` | `*.<base_domain>` |
| R2 public bucket | `<public-name>.r2.<base_domain>` | `*.r2.<base_domain>` |
| KV public endpoint | `<public-name>.kv.<base_domain>` | `*.kv.<base_domain>` |

KV 行固定未来的命名方法。新增公开产品在 HTTP contract 完成后加入平台固定枚举。

`public-name` 是独立持久化的 DNS label：格式为 1–63 个小写 ASCII 字母、数字或中间位置的 `-`；在所属 namespace 内唯一，
完整 hostname 在实例内全局唯一。资源 display name 与公网 URL 分别管理。

公网 URL 不包含 account。binding 保存 `account_id` 和 target identity，控制面按 account 授权，data plane 只按 canonical
hostname 读取已经持久化的 target。Worker 根 namespace 至少保留 `ingress`、`ns1`、`r2`、`kv`、`api`、`admin`、
`health` 和 `operator`。

## 4. 用户手工 DNS setup

operator 保留普通 DNS zone 的管理权。setup 根据 `base_domain`、启用的产品和 operator 显式输入的公网 IPv4/IPv6 输出一份
固定 record plan；用户在现有 DNS provider 中手工创建，`ocd` 以只读方式验证结果。

以 `base_domain=ocd.com`、启用 Worker 和 R2 为例：

```dns
; 业务流量
ingress.ocd.com.                 A       203.0.113.10
*.ocd.com.                       CNAME   ingress.ocd.com.
*.r2.ocd.com.                    CNAME   ingress.ocd.com.

; ACME challenge DNS
ns1.ocd.com.                     A       203.0.113.10
_acme-challenge.ocd.com.         NS      ns1.ocd.com.
_acme-challenge.r2.ocd.com.      NS      ns1.ocd.com.
```

有公网 IPv6 时为 `ingress` 和 `ns1` 增加 AAAA。KV 只有在公开产品合同实现后才增加：

```dns
*.kv.ocd.com.                    CNAME   ingress.ocd.com.
_acme-challenge.kv.ocd.com.      NS      ns1.ocd.com.
```

每个 certificate namespace 配置独立 challenge delegation：`*.ocd.com` 的 TXT 查询发生在
`_acme-challenge.ocd.com`，`*.r2.ocd.com` 的查询发生在 `_acme-challenge.r2.ocd.com`。

`ingress` 和 `ns1` 使用显式记录并优先于 `*.ocd.com`。Day 1 公网 endpoint 全部位于 wildcard namespace 下。

setup verification 必须从公共递归 resolver 和目标权威链验证：

- `ingress` 与每个业务 wildcard 最终解析到 operator 声明的地址；
- challenge 名称确实通过 NS 委派到 `ns1`；
- `ns1` 的 A/AAAA 可从公网解析；
- UDP/TCP 53 都能取得该 challenge zone 的 SOA/NS 响应；
- CAA 授权配置的 ACME CA；
- 公共递归 resolver 与权威查询结果共同构成公网成功证据。

普通 daemon startup 以只读方式检查 DNS。DNS drift 进入 gateway health 和 doctor；operator 修改记录后显式重新验证。

## 5. Wildcard TLS 与自有 Caddy DNS provider

### 5.1 固定证书

每个启用的 namespace 使用独立 wildcard certificate：

```text
workers -> *.<base_domain>
r2      -> *.r2.<base_domain>
kv      -> *.kv.<base_domain>
```

独立 certificate 将 challenge、renewal 和 health 状态限制在对应产品 namespace。
新增资源复用 namespace wildcard certificate。Caddy 在 namespace onboarding 时申请证书，并在到期前通过相同 DNS-01 路径
自动续期。

### 5.2 `dns.providers.opencompute`

正式 Caddy 编译一个项目自有的 `dns.providers.opencompute` module。它沿用 `caddy-dns/cloudflare` 的 module wiring，并把
libdns record 操作连接到 ocd 本地 challenge authority。

因为 `ocd` 只生成原生 Caddy JSON，module 按 [Caddy module contract](https://caddyserver.com/docs/extending-caddy) 实现
`CaddyModule`、`Provision` 和最小 libdns record interface。

provider 只实现 Caddy/CertMagic DNS-01 所需的最小 libdns append/delete contract：

1. Caddy 生成 `_acme-challenge` TXT token；
2. provider 通过 ocd 创建的私有 Unix socket 把 record name、value 和有界 TTL 交给父进程；
3. `ocd` 校验名称严格等于当前 active/provisioning namespace 的 challenge apex，拒绝任意 zone、record type 和超长 value；
4. `ocd` challenge DNS 在内存中发布 TXT，并向 provider 返回 opaque record ID；
5. Caddy 完成 propagation check 和 ACME validation；
6. provider cleanup 按 record ID 删除 TXT；未知、重复或过期 cleanup 幂等处理。

Unix socket 位于 `0700` data-dir 私有目录，socket/config path 不是 capability；文件权限和 peer process identity 限制写入者。
provider update path 只存在于本机私有 Unix socket。argv、环境变量、日志、status 和持久 Caddy JSON 只包含非秘密配置；
challenge token 作为短期可重建状态保存在内存中，进程恢复后由 Caddy 重新发起 order。

### 5.3 challenge 权威 DNS

`ocd` 只服务 setup 中明确委派的 challenge zones，例如：

```text
_acme-challenge.ocd.com
_acme-challenge.r2.ocd.com
```

它回答必要的 SOA、NS 和 TXT，支持 UDP/TCP DNS，设置有界 TTL、报文和并发限制。zone/name/type 使用固定 allowlist，其他查询
返回权威 negative response 或 `REFUSED`。

公网 53 可以直接绑定，也可以由 NAT/四层代理把 UDP/TCP 53 转发到非特权内部端口。支持的部署环境保证公网 UDP/TCP 53
能够到达该 responder。

### 5.4 Caddy certificate ownership

Caddy 独占 ACME account、private key、certificate renewal 和持久化 storage：

- storage 位于 ocd data-dir 的私有 gateway 子目录，目录 `0700`、secret files 至少 `0600`；
- Caddy storage 是需要保护和备份的 secret state；support bundle 只输出摘要和健康状态；
- 丢失 storage 不触发自动“修复”，因为批量重签可能命中 CA rate limit；
- `ocd` 不解析、导出、复制或改写 Caddy private key；
- certificate readiness 同时使用 child liveness 与真实 TLS handshake 检查 SNI、chain、SAN 和有效期；
- renewal failure 进入 gateway health，不触发 `ocd`、workerd 或 Caddy 的无界 restart loop；尚有效证书继续服务。

正式配置固定一个 ACME CA endpoint。测试使用 staging 或仓库 fixture CA，生产 qualification 使用正式 endpoint。

## 6. Pinned Caddy 与单二进制分发

P18 沿用 workerd 的供应链模型。定制 binary 在 release build 阶段按
[Caddy 官方 custom build 方式](https://caddyserver.com/docs/build)生成，但正式输入全部由仓库 lock 固定。

### 6.1 正式 pin

实现时新增一个权威 Caddy lock，记录：

- Caddy release/tag 与 source revision；
- `dns.providers.opencompute` source revision；
- Go toolchain、完整 module graph/`go.sum` 输入；
- 每个正式 target 的 binary size、SHA-256、`caddy version`、`caddy build-info`；
- `caddy list-modules` 的精确允许集合，包含自有 provider 和正式配置需要的标准 module；
- Caddy JSON contract/version、ACME CA、HTTP protocol 和 process flags。

正式 target 与 `ocd` release matrix 一致。每个平台的定制 Caddy binary 通过 Git LFS 保存在 `share/caddy/`，构建先验证 lock、
目标、摘要、version、build info 和 module inventory，再生成确定性压缩输入并嵌入对应平台的 `ocd`。

升级 Caddy 或任一 Go module 是显式 coordinated dependency update：更新 lock/LFS bytes/licenses，重新执行 DNS-01、TLS、supervisor、
restart 和 packaged-offline qualification。运行时始终使用内嵌并完成摘要验证的 Caddy payload。

### 6.2 离线物化与监督

取得 data-dir 排他锁后，`ocd` 把内嵌 Caddy 原子物化到按 payload digest 定位的私有 runtime 目录，逐次启动前验证 bytes、版本和
module inventory。已有文件损坏时拒绝启动，不静默覆盖后继续。

```text
ocd（唯一分发文件）
  ├─ data/runtime/packages/<payload-sha256>/workerd
  ├─ data/runtime/packages/<payload-sha256>/caddy
  ├─ workerd child
  ├─ pinned Caddy child
  └─ ocd
       ├─ SQLite/hostname authority
       ├─ public data-plane upstream
       └─ challenge DNS UDP/TCP
```

P17 Host Process Runtime 负责 Caddy 的 verified launch、process group、bounded stdout/stderr、TERM/KILL/reap 与 orphan
primitives；P17 Coordinator 负责 permit、inventory 和 shutdown coordination。P18 `GatewayManager` 独占 typed Caddy JSON、配置验证、
TLS readiness、ACME storage、restart/backoff 和 gateway health。Caddy admin API 默认禁用；完整配置先用正式 pinned binary
validate，再原子发布并启动或受控重启。

Caddy 和自有 module 的许可证及 notices 必须进入 `ocd licenses`。P18 实现完成时同步更新
[`single-binary.md`](references/single-binary.md) 的内嵌内容、物化布局、构建输入和正式单文件测试。

## 7. 两种网络拓扑，一套运行合同

两种方式都由同一个 Caddy child 管理证书并终止 TLS，差异只在公网 TCP 443 如何到达 Caddy listen address。

### 7.1 ocd 完整托管

```text
Internet TCP 443       -> Caddy :443（或 NAT -> private :8443）
Internet UDP/TCP 53    -> ocd DNS :53（或 NAT -> private :8053）
Caddy                  -> private ocd HTTP listener
```

operator 可以授予低端口 bind capability，也可以在路由器/宿主防火墙做端口映射；`ocd` 不请求 root、不自动修改 firewall、
NAT、UPnP 或系统 capability。

### 7.2 现有代理 passthrough

```text
Internet TCP 443
        -> existing L4 proxy: inspect SNI only
        -> raw TCP/TLS passthrough to Caddy private :8443
Internet UDP/TCP 53
        -> direct/NAT/L4 forwarding to ocd DNS private :8053
```

前置代理把 ocd namespace 的原始 TLS bytes 透传到 Caddy。客户端握手最终发生在 Caddy，因此看到的就是 Caddy 申请和续期的
证书；certificate lifecycle 全部留在 ocd/Caddy 内部。

passthrough rule 只匹配严格单层的 `*.<base_domain>`、`*.r2.<base_domain>` 等 namespace；未匹配 SNI 保持现有站点行为。
Nginx 需要 [`stream` + `ssl_preread`](https://nginx.org/en/docs/stream/ngx_stream_ssl_preread_module.html)，Traefik 可使用
[TCP router `tls.passthrough=true`](https://doc.traefik.io/traefik/reference/routing-configuration/tcp/tls/)。P18 提供这两种 reference
snippet，其他四层代理遵循相同 SNI passthrough contract。

passthrough topology 可选用 PROXY protocol v2 保留真实 client IP；Caddy 从显式 allowlist 的 proxy 地址接收该 metadata。
hostname authorization 始终使用 SNI、Host 和 SQLite binding。

## 8. Caddy projection 与 `ocd` Host authority

hostname claim、typed product route、可信 ingress context 和 endpoint projection 的共享合同由
[Host authority](references/host-authority.md)拥有，并由 R0 先行实现。P18 不建立第二套 hostname registry；本节只定义 Caddy
projection 和公网 binding 的附加状态。

Caddy JSON 是从 SQLite/config authority 生成的可重建 projection，只包含：

- 固定 HTTPS listener 和关闭 HTTP/3 的 protocol 设置；
- 每个 active product namespace 的严格 wildcard SNI/Host matcher；
- 每个 namespace 的独立 ACME DNS-01 automation policy；
- `dns.providers.opencompute` 本地 Unix socket 配置；
- 一个指向 private ocd data-plane listener 的 upstream；
- Host preservation、forwarded header overwrite、timeouts 和 streaming/WebSocket 所需 transport 设置；
- 私有 Caddy storage path、禁用 admin API 和 secret-free logs。

projection 不包含 resource/account/deployment ID、DNS provider credential、ACME token、自由模板或 tenant input。resource binding
变化不重载 Caddy；只有 domain onboarding 或固定 product namespace enable/disable 才重新生成完整配置。

公网 hostname 使用 R0 建立的实例级 claim authority。P18 必须保证：

- public-name claim 和 product-owned typed binding 在同一 SQLite transaction 中创建或切换；
- product repository 验证 target 存在、属于 account 且允许 public access；
- Worker、R2/KV 等产品通过各自带外键的 binding/route 引用共享 claim，不使用通用 dangling target ID；
- resource binding 变化只修改 SQLite authority，不进入 Caddy config，也不依赖进程内 map。

P18 tenant hostname 的所有 path 都进入对应 product ingress。`/health/*`、Artifacts 和控制面 path 只在明确的平台 listener/host
可达；tenant 可以合法拥有这些 path。unknown、保留但未激活、disabled 或 tombstoned hostname 返回稳定 404。

Caddy 必须移除外部传入的 `Forwarded`、`X-Forwarded-*`、`CF-Connecting-IP` 和 open-compute internal headers，再生成受信的
scheme/host/client metadata。`ocd` 只信任 Caddy 的精确 private peer，并重新校验 canonical Host；Caddy 不获得 admin/deployer
token、SQLite、workerd internal endpoint 或 tenant identity。

## 9. 生命周期

### 9.1 Domain onboarding

一次 setup 按以下顺序执行：

1. 校验 `base_domain`、公网 ingress/DNS address 和本地 listen address；
2. 输出完整业务 wildcard 与 challenge NS record plan，不执行外部写入；
3. operator 手工配置记录，并建立 TCP 443、UDP/TCP 53 的直达或转发；
4. `ocd` 以 provisioning 状态启动最小 challenge DNS；
5. 显式 verify 从公网 DNS 路径检查 A/AAAA、CNAME、NS、SOA、UDP/TCP 53 和 CAA；
6. 生成并 validate Caddy JSON，启动 pinned Caddy；
7. Caddy 通过自有 provider 发布 TXT，取得每个 active namespace 的 wildcard certificate；
8. 对保留 probe hostname 执行真实 TLS handshake；全部成功后将 gateway/namespace 标记 active。

失败保存精确阶段和 sanitized error，显式 retry 从最近安全阶段继续；ACME retry 使用有界退避和 order budget。

### 9.2 Product namespace

Worker namespace 是基础能力；R2 等产品只有在 HTTP contract 实现后显式启用。enable 验证对应业务 wildcard 与 challenge NS，
更新 Caddy projection、取得证书并完成 TLS probe，之后才允许资源声明 public binding。

disable 只在不存在 active/pending binding 时允许；先禁止新 claim，再移除 Caddy policy/router。P18 不自动删除用户手工 DNS，
也不删除历史 certificate/private key 来假装清理完成。

### 9.3 Resource binding

namespace active 后，资源公网操作只有一个 SQLite transaction：校验 account、产品能力、`public-name` 和保留名称，声明或切换
exact hostname，返回稳定 HTTPS URL。该流程不访问 DNS、ACME 或 Caddy。

Worker deploy 的 `workers_dev`/subdomain intent 可以调用同一 authority，但 URL 不包含 Cloudflare account subdomain；兼容文档
必须记录这一 hostname-shape deviation。

## 10. 状态、持久化与失败语义

domain/namespace 只保留完成恢复所需的状态：

```text
provisioning
active
degraded
disabling
```

`control.sqlite` 保存 base domain、enabled namespace、workflow generation/阶段、公网 claim 的附加状态、projection digest 和最近成功
TLS qualification metadata；hostname ownership 和 typed target relation 复用 R0 authority。ACME account、certificate 和 private key
由 Caddy storage 独占。

Caddy storage 是 certificate/ACME secret authority；Caddy JSON 是可重建 projection；内存 challenge TXT 是短期状态；用户 DNS zone
是手工配置的外部 authority。每项状态都有唯一 owner。

失败语义：

- DNS 未配置/错误：签发前失败，显示缺失或冲突 record，不修改外部 DNS；
- UDP/TCP 53 不可达：namespace 保持 provisioning/degraded，等待端口和 delegation 恢复；
- TXT propagation timeout：清理本次 token，有界退避，显式 retry；
- ACME issuance failure：保留 Caddy storage/account，binding admission 关闭；
- certificate renewal failure：继续服务尚有效证书并报警，不重启 workerd；
- Caddy config validation failure：保留上一份有效 projection/child；
- Caddy crash：按 supervisor backoff 重启，反复失败后 gateway degraded，不拖垮控制面和内部 runtime；
- ocd restart：从 SQLite 和 Caddy storage 恢复，丢弃陈旧 challenge token；
- 外部 DNS drift：doctor 报告，不在 startup/background loop 自动修改；
- Caddy storage 损坏：fail closed 并保留证据，不自动删除后批量重签。

公网 DNS/ACME 状态进入独立、secret-free gateway health component；`/health/ready` 继续表达 ocd/workerd admission state。

## 11. 配置与 operator experience

配置只保存静态 operator intent，示意如下：

```toml
[public_gateway]
base_domain = "ocd.com"
ingress_ipv4 = ["203.0.113.10"]
ingress_ipv6 = []
https_listen = "0.0.0.0:8443"
challenge_dns_listen = "0.0.0.0:8053"
proxy_protocol_from = []
```

两种拓扑使用同一 Caddy 和 DNS listener。operator 通过 listen address 与外部端口转发配置网络路径，证书和 DNS-01 配置保持
一致。

API/CLI/dashboard 必须提供：

- 生成无 mutation 的 DNS/port plan；
- 验证 DNS、端口、Caddy pin、ACME 和 TLS 的分阶段状态；
- 显式 retry/reconcile onboarding；
- enable/disable 固定 product namespace；
- 为资源 enable/disable/update public name；
- 输出最终 HTTPS URL；
- 输出 Nginx stream 与 Traefik TCP passthrough reference snippet；
- 生成 secret-free gateway doctor/support report。

正常资源页面不要求用户理解 ACME。只有首次 setup、namespace 非 active 或 renewal health 异常时才显示 DNS/port operator action。

## 12. 安全边界

- challenge NS delegation等价于授权 ocd 为对应 wildcard 申请证书，setup 必须明确展示该权限；
- 权威 DNS 禁止 recursion、任意 update、zone transfer 和非 challenge zone；
- Caddy provider 只能连接 data-dir 内的私有 Unix socket，只能 append/delete TXT；
- challenge record name 使用 structured DNS name 和固定 zone allowlist 精确匹配；
- Caddy 的生成 config、argv 和环境不包含 SQLite、master key、S3、admin API token 或 workerd internal capability；
- Caddy 与 ocd 当前以同一 OS identity 运行，因此 Caddy 属于受 pin 和 supply-chain Gate 约束的 trusted computing base；
- certificate/private key、ACME account 和 challenge token不进入 SQLite GET API、日志、metrics、support bundle、argv 或环境变量；
- Caddy upstream 由平台固定为 private ocd listener；
- Host/SNI 不一致、unknown namespace/binding、disabled target 和 corrupt persisted state全部 fail closed；
- direct/passthrough 都由 Caddy 终止 TLS，并经过相同 hostname authority；
- PROXY protocol peer 使用精确 allowlist；
- Caddy 和 Go dependency pin、module inventory、embedded bytes 与运行时 executable identity 都是 release/Gate 输入。

## 13. 实施顺序

1. **Caddy supply chain**：冻结 Caddy/Go/module pin，构建三平台定制 binary，建立 lock、LFS bytes、licenses 与离线物化验证。
2. **Open Compute provider**：实现最小 `dns.providers.opencompute` libdns adapter 和私有 Unix-socket protocol。
3. **Challenge DNS**：实现固定 zone 的 UDP/TCP SOA/NS/TXT authoritative responder、无 recursion 和边界测试。
4. **GatewayManager**：复用 P17 Host Process Runtime 与 Coordinator，增加 typed JSON、storage、readiness 和 restart recovery。
5. **Domain authority**：追加 migration，建立 singleton domain、namespace workflow，并复用 R0 hostname claim/typed binding authority。
6. **Host ingress**：复用 R0 Host-first resolver，实现 Caddy trusted-ingress boundary、public Worker URL 与 passthrough PROXY protocol
   allowlist。
7. **R2 public bucket**：R2 HTTP/access contract 冻结后启用 `r2` namespace。
8. **Operator surface**：DNS plan/verify、gateway doctor、Nginx/Traefik snippet 和真实 onboarding qualification。

每一步同步更新当前 Day 1 producer、consumer、schema、fixtures 和文档。已发布 database migration bytes 保持不变，schema 变化
通过新 migration 追加。

## 14. 验收

### 14.1 常规测试

- base-domain canonicalization、IDNA、public-suffix 和 malicious suffix；
- public-name、保留名称、跨 account/global conflict 和 namespace 隔离；
- 固定 DNS plan 对 apex/subdomain base 的正确展开；
- challenge zone exact allowlist、SOA/NS/TXT、UDP/TCP、negative response、无 recursion/AXFR/update；
- provider append/delete、opaque ID、重复 cleanup、非法 name/type/value 和 crash token loss；
- Caddy lock、target、checksum、version、build-info、module allowlist、损坏 payload 拒绝；
- typed JSON deterministic projection、validation、atomic replace 和 restart rebuild；
- Caddy storage permissions、redaction、backup contract 和损坏 fail-closed；
- Host-first dispatch、tenant path 不落入平台 handler、spoofed forwarded header stripping；
- direct 与 PROXY-protocol allowlisted passthrough client identity；
- namespace active 后资源创建/删除只更新 hostname authority，DNS/Caddy projection 保持稳定；
- workflow checkpoint crash/restart 不创建重复 ACME loop；
- single-binary isolated startup 只加载内嵌 pinned Caddy child；ACME 网络访问限定在显式 onboarding 和后台 renewal 路径。

### 14.2 真实 ingress qualification

首次正式启用必须使用专用测试 domain、正式 pin 的 packaged `ocd` 和受控 ACME staging/production：

- 对 dedicated apex 与 dedicated subdomain 各验证一次完整 record plan；
- UDP/TCP 53 公网权威查询、NS delegation 与临时 TXT propagation 正常；
- Worker 与 R2 分别取得正确 wildcard certificate，错误层级 hostname 不被覆盖；
- Caddy restart、ocd restart、token cleanup、ACME/DNS 暂时失败和 storage reuse 不导致无界重签；
- 完整托管与现有代理 SNI passthrough 都由同一 Caddy certificate 完成真实 TLS handshake；
- HTTP/1.1、HTTP/2、streaming 和 WebSocket 正常，协议广告与 Day 1 h1/h2 合同一致；
- 两个 account 争用同一 hostname 时只有一个成功；
- Caddy config、argv、环境和 provider protocol 不包含 SQLite、master key、S3、admin token、workerd internal capability 或任意
  DNS provider credential；
- 测试结束没有遗留 listener、challenge TXT、临时 secret、未记录 process 或测试 resource。

真实 DNS/ACME qualification 使用固定 Caddy bytes、专用 domain 和公网 UDP/TCP 53，并作为独立受控外部验收记录。

## 15. 文档与兼容声明

实施时同步：

- 更新 [`references/cloudflare-compatibility.md`](references/cloudflare-compatibility.md)，记录 Workers/R2 public URL 的精确
  single-domain deviation；
- 更新 [`references/single-binary.md`](references/single-binary.md)，加入 pinned Caddy build/payload/process/storage；
- 更新 install/runbook，列出固定 DNS records、TCP 443、UDP/TCP 53、直接/NAT/passthrough 和 PROXY protocol；
- 更新 backup/restore，保护 SQLite authority 与 Caddy ACME storage，challenge token不进 snapshot；
- 更新 doctor/support bundle，输出 secret-free DNS delegation、Caddy pin、namespace、certificate 和 renewal 状态；
- 更新 capability manifest、Wrangler fixtures 和 dashboard 文案，统一使用 open-compute public URL 术语。

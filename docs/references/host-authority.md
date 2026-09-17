# Host ingress 与 hostname authority

本文持续维护 open-compute 本机和公网 HTTP ingress 共用的 hostname ownership 与解析合同。具体实施、迁移和资格分别由 R0、P18
及后续产品文档拥有。

## 唯一 authority

`ocd` 是 hostname 到 product target 的唯一解析 authority：

```text
canonical authority + pathname
              |
              v
persisted hostname claim
              |
              v
typed product binding / route
              |
              v
Worker | R2 | another explicit HTTP product
```

- canonical hostname 在实例内全局 claim；claim 保存 account、product namespace、state、generation 和 lifecycle metadata；
- 一个 hostname 只归属一个 product namespace；该 product 可以继续执行自己声明的 path routing；
- target 使用带真实外键的 product-owned binding/route 表表达；禁止使用没有 referential integrity 的通用
  `target_kind + target_id`；
- 自动生成的 Worker origin 和公开 bucket origin 绑定 `/`，因此该 origin 的全部 path 归属同一 target；
- SQLite 是 authority；Gateway config、runtime memory、endpoint response 和 SDK model 都只是 projection。

R0 已建立全局 hostname claim 和 Worker typed route，默认 Worker endpoint 为
`<worker>.<account>.localhost`。后续公网 Gateway 和其他 HTTP 产品复用该 authority，不建立第二套 hostname registry、内存 route map
或 Gateway-owned resource mapping。

## 传输路径

```text
local client  --HTTP------------------------> ocd ingress
public client --HTTPS--> Gateway/TLS child --> private ocd ingress
                                                   |
                                                   `-- same hostname authority
```

Gateway 是可选 transport edge，只拥有 TLS、ACME、固定 product namespace admission、外部 header 清洗和一个固定 `ocd` upstream。
它不接收逐 Worker/bucket route，不持有 deployment/account mapping；资源创建、删除和切换不得触发 Gateway reload。

`ocd` 从实际 listener 建立可信 ingress context。直接 listener 使用实际 scheme/client address；Gateway private listener 只接受经过固定
peer/socket boundary 的 Gateway，并使用其覆盖后的 external scheme/client metadata。外部 `Forwarded`、`X-Forwarded-*` 与平台内部
header 不能自行提升为可信 context。两条路径最终使用相同的 canonical Host resolver；transport metadata 不进入 hostname ownership。

平台管理的 tenant hostname 必须在 path-based 控制面 router 之前解析。匹配后，`/health`、`/client/v4`、`/operator` 等 path 都是
tenant path；unknown、disabled、tombstoned 或 Host/SNI 不一致均 fail closed。

## Endpoint projection

Endpoint API 从 hostname authority 和实际 listener capability 投影 URL：本机返回 `local_origin`，启用 Gateway 后可以增加
`public_origin`。endpoint 不是另一套路由 authority；listener 不可达或公网 namespace 未 active 时不发布对应 URL，也不阻止 Worker
deployment 建立本机可用状态。

## 实施归属

- [R0 Worker `.localhost` Origin 重构](../implemented/r0-localhost-worker-origins.md)：已落地 hostname claim、Worker typed route、Host-first
  ingress 与 endpoint projection；
- [P17 宿主子进程管理基础设施](../implemented/p17-host-process-infrastructure.md)：提供 verified child 的通用 process ownership，不拥有路由；
- [P18 单域名公网网关、DNS 与 TLS](../p18-single-domain-public-gateway.md)：复用 R0 authority，增加公网 DNS、TLS、Gateway transport
  与 public binding lifecycle。

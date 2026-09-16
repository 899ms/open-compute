# R0：Worker `.localhost` Origin 重构

状态：**blocked**。该重构对应 GitHub `#90`；按当前实施顺序等待
[P17 宿主子进程管理基础设施](p17-host-process-infrastructure.md) 完成并通过验收后再启动。它将现有 `platform_path` tenant
ingress 改为 Cloudflare `workers.dev` 同形的本机 exact-host origin；部署不依赖 P18 Gateway 或用户 DNS。

R0 是 [Host authority](references/host-authority.md) 的首个实施批次；共享 hostname claim、typed product binding 和 Gateway/ocd
边界以该 reference 为准，本文只定义 Worker `.localhost` 的迁移与验收。

## 1. 结果与范围

R0 固定以下 Day 1 合同：

- 每个 tenant Worker 自动取得一个本机 origin：
  `http://<worker-name>.<account-id>.localhost:<public-port>/`；
- Worker create、Version upload、deployment activation、Service Binding 和其他内部调用均不依赖 Gateway、DNS 或 TLS；
- `.localhost` origin 使用 persisted exact-host route，所有 path 都属于该 Worker；
- Worker、Static Assets、SPA fallback、redirect 和 `fetch()` 看到的 pathname 均从 `/` 开始，不包含平台路由前缀；
- `platform_path` 不再是 tenant endpoint，也不作为失败时的 fallback；
- P18 继续拥有可选的公网 HTTPS hostname、wildcard DNS 和证书生命周期；未配置 P18 不影响 deploy；
- `.localhost` 只承诺访问客户端与 `ocd` 位于同一台主机。LAN 或公网客户端必须使用 P18 或 operator 明确配置的其他 exact hostname。

R0 是现有 Worker ingress、route persistence、vendor endpoint API 与 SDK 的协调重构，不新增第二套路由引擎，也不修改 workerd。
P17 先完成通用宿主进程 ownership；R0 随后建立本机 origin 与 host authority；P18 最后消费两者。

## 2. 当前问题

当前 Worker create 自动持久化：

```text
/__workers/<account-id>/<worker-name>/
```

`ocd` 使用该前缀选择 Worker，又把包含前缀的完整 URL 交给 runtime：

```text
GET /__workers/A/app/assets/app.js
                    |
                    +-- Worker 和 Static Assets 仍看到完整平台路径
```

这违反 origin round-trip 不变量：Worker 生成或返回同源绝对 URL `/assets/app.js` 后，客户端必须能用同一 origin 再次请求并回到同一
Worker。只在 dispatch 前删除前缀不能修复该问题，因为客户端随后请求 `http://127.0.0.1:8787/assets/app.js` 时已没有 Worker
identity，路由发生在 URL 重写之前。

R0 用 hostname 承载 Worker identity：

```text
GET /assets/app.js
Host: app.<account-id>.localhost:8787
                 |
                 +-- exact Host -> Worker -> pathname /assets/app.js
```

Cloudflare 的 `workers.dev` URL 使用 `<worker>.<account-subdomain>.workers.dev`。R0 将平台域替换为 RFC 6761 保留的 `.localhost`，
保持相同的 Worker/account hostname 层级。依据：

- [Cloudflare workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)；
- [RFC 6761 localhost special-use names](https://www.rfc-editor.org/rfc/rfc6761.html#section-6.3)；
- [W3C Secure Contexts localhost rules](https://www.w3.org/TR/secure-contexts/#localhost)。

## 3. Canonical local origin

### 3.1 Hostname

Canonical hostname 为：

```text
<worker-name>.<account-id>.localhost
```

- `worker-name` 复用 Worker authority 已有的 lowercase ASCII DNS-label 校验，长度为 1–63；
- `account-id` 使用 canonical lowercase hyphenated UUIDv7，长度为 36，也是合法 DNS label；
- 每段和完整 hostname 都在持久化前校验，不在读取或展示时修复；
- hostname 不接受尾随 dot、Unicode、大小写别名、IP literal、port 或用户提供的替代拼写；
- system-owned Dashboard Worker 不取得 tenant `.localhost` route。

Worker rename 当前不是产品能力；若以后增加 rename，新名字是新 origin，必须原子 claim 后切换，旧 hostname 立即 tombstone，不保留
alias 或 redirect。

### 3.2 Scheme、port 与可用性

本机 endpoint 使用 `http`，port 来自实际 bound public listener，不能写死 `8787`。默认配置产生：

```text
http://app.0199cafe-0000-7000-8000-000000000001.localhost:8787/
```

`.localhost` 可同时解析为 `127.0.0.1` 与 `::1`。正式支持前，public service 必须在同一逻辑 listener/port 上覆盖两个 loopback
family，或用真实客户端 Gate 证明所有受支持客户端对当前单 family bind 都会可靠 fallback。不得把偶然的 resolver 顺序当作合同。

只有 public listener 可从本机 loopback 到达时才发布 local origin。显式只绑定某个非 loopback interface 时，deploy 仍成功，但 endpoint
列表不虚构不可达的 `.localhost` URL。远程浏览器中的 `.localhost` 指向浏览器所在主机，不指向 `ocd` server。

HTTP `.localhost` 可被符合 Secure Contexts 规则的浏览器视为 potentially trustworthy，但不等于生产 HTTPS。R0 不承诺 TLS、HSTS、
`Secure` Cookie 或依赖 `request.url.protocol === "https:"` 的生产行为；这些由 P18 qualification 覆盖。

## 4. Route authority 与 ingress

### 4.1 Persistence

R0 按 [Host authority](references/host-authority.md) 建立实例级 hostname claim，并用 Worker-owned typed route 保持真实外键。
tenant Worker create 在同一个 SQLite transaction 中创建 Worker、observability defaults、claim 和自动 local route：

```text
hostname claim
  hostname_ascii  <worker-name>.<account-id>.localhost
  account_id      <account-id>
  namespace       worker
  exposure        local
  state           active
  generation      1

worker host route
  claim_id        <hostname-claim-id>
  worker_id       <worker-id>
  path_prefix     /
  entrypoint      NULL
```

claim ID、generation、audit、delete/tombstone 和 restart recovery 由 SQLite authority 持有。active canonical hostname 必须实例级唯一，
不能只在 account 内唯一；数据库约束和 repository 校验同时执行。claim 先确定 product namespace，Worker route 再解析 path 和 target。
不建立无外键的通用 `target_kind + target_id`；后续产品通过自己的 typed binding 表引用同一 hostname claim。

已发布 migration 字节保持不变。实现追加下一条 contiguous control migration：

1. 校验所有 live tenant Worker name/account ID 可生成 canonical hostname；
2. 建立全局 hostname claim 与 Worker typed host route authority；
3. 将每个 active `platform_path` 原子转换为 local claim 和 `/` Worker route；
4. 拒绝 hostname collision、缺失 route、重复 active route、dangling relation 或其他不一致状态；
5. 移除当前 schema 中 superseded 的 platform-path authority，并建立实例级 active hostname 唯一约束；
6. 更新 schema registry、checksum、fixtures、snapshot/restore 和 migration regression。

迁移后当前代码只生产和解析 hostname claim + typed Worker route，不保留 `worker_routes` exact-host registry、platform-path dual
read/write 或旧 endpoint fallback。现有 `worker_routes` 是迁移输入，不继续作为第二套 hostname authority。

### 4.2 Dispatch

tenant ingress 顺序固定为：

1. 从直接 HTTP authority 读取并 canonicalize Host；
2. exact match active persisted hostname claim，并确认 namespace 为 Worker；
3. 在 typed Worker route 中解析 pathname，并 freeze route generation、active deployment/version；
4. 将原始 method、query、Host 和从 `/` 开始的 pathname 交给 workerd；
5. unknown、disabled、tombstoned 或不一致 route 返回稳定 404。

`*.localhost` 是 platform-managed namespace。该 suffix 下 exact match 失败后禁止转入控制面、Dashboard、其他 tenant route 或默认 Worker。
外部 `Forwarded`、`X-Forwarded-*` 和 `x-open-compute-*` 仍在信任边界覆盖或移除；`.localhost` Host 不是认证凭据，也不获得管理权限。

tenant hostname 上的 `/health/*`、`/client/v4/*`、`/operator/*` 和其他平台路径属于 tenant request，不得被 public/admin router 抢占。
控制面继续通过明确的平台 listener/authority 暴露。

## 5. Endpoint API 与 SDK

现有 vendor endpoint 只返回 route `path`，无法表达 origin。R0 直接替换为当前 Day 1 shape：

```json
{
  "id": "<route-id>",
  "kind": "local_origin",
  "url": "http://app.<account-id>.localhost:8787/",
  "scope": "local_machine",
  "created_on": "2026-09-16T00:00:00Z"
}
```

- `url` 是 absolute origin URL，固定以 `/` 结束且没有 credential、query 或 fragment；
- `kind` 是闭合枚举，P18 后续增加 `public_origin`；
- `scope` 明确 local origin 不能从远程客户端使用；
- listener 不满足 local-origin 可达条件时返回空列表，而不是使 deploy 失败；
- OpenAPI extension、生成 SDK、Dashboard、website docs、examples 和 consumer tests 同批更新；
- 不保留旧 `path` 字段或根据 client version 返回两种 shape。

P18 public endpoint 使用相同的 route/endpoint authority，但返回 `https` `public_origin`。P18 当前独立持久化 `public-name`，因此公网
hostname 可以保持 `<public-name>.<base_domain>`；R0 不强制把内部 account UUID 暴露在公网 URL。

## 6. Static Assets 与 Worker 行为

Host route 完成后，Loader 不再知道或删除平台 mount prefix。Worker 与 trusted Static Assets router 接收同一个 tenant Request：

```text
request.url             http://app.<account>.localhost:8787/assets/app.js
URL.pathname            /assets/app.js
manifest lookup         /assets/app.js
SPA navigation          /
run_worker_first rules  /api/*
redirect/header rules   /docs/*
```

不得通过 HTML `<base>` 注入、响应正文替换、Referer/Cookie 推断或 Worker wrapper 修复路径。这些方案无法覆盖动态 `fetch()`、redirect、
WebSocket、模块 URL 和非 HTML 客户端，并会建立第二套路由语义。

## 7. 与 P17/P18 的边界

共享边界由 [Host authority](references/host-authority.md) 定义。R0 首先提供 Host-first tenant ingress、hostname claim、Worker
typed route 和 origin endpoint API；P18 在其上增加：

- operator-owned `base_domain`；
- 公网 DNS/wildcard namespace；
- HTTPS、ACME 和 Caddy projection；
- public-name claim 和公网 qualification。

因此 lifecycle 为：

```text
deploy
  -> local origin（loopback listener 可达时自动存在）
  -> optional P18 publish（Gateway active 后声明 public origin）
```

P17 后续把 Caddy 纳入 `GatewayManager` 和通用 child ownership；R0 不等待该工作，也不启动额外 child。P18 不是 deploy
prerequisite，R0 也不创建 DNS record、certificate 或 Caddy child。

## 8. 实施顺序

1. **Authority**：加入 canonical local hostname helper，追加 migration，并把 Worker create/delete/list route 收敛到 hostname claim +
   typed Worker route；
2. **Ingress**：改为 managed Host-first dispatch，移除 platform-path fallback，保证 tenant path 不被控制面路由抢占；
3. **Runtime request**：删除 mount-prefix 假设，保持 Host、path、query、streaming、WebSocket 和 cancellation 行为；
4. **Endpoint contract**：更新 extension OpenAPI、SDK generator、Dashboard 和 CLI 展示；
5. **Assets regression**：覆盖 asset manifest、SPA、worker-first、redirect/header rules 和 MIME；
6. **Migration/recovery**：覆盖旧 release 数据、restart、snapshot/restore、delete/recreate 和 corrupt-state rejection；
7. **Qualification**：在受支持 macOS/Linux 上用 Chrome、Firefox、Node 和 curl 验证 DNS resolution、IPv4/IPv6、origin isolation 与真实
   workerd。

每个批次直接更新唯一 authoritative 模型；不保留旧 route mode feature flag、双 endpoint API 或运行时兼容 wrapper。

## 9. 验收

R0 只有同时满足以下条件才可归档：

- 新 Worker 自动取得且只取得正确的 local hostname claim 与 `/` typed Worker route；
- endpoint URL 的 port 来自实际 listener，远程-only bind 不发布虚假 local origin；
- unknown/跨 account/大小写/尾随 dot/端口欺骗 Host 均 fail closed；
- Worker 收到 `/`、query 和 absolute URL authority，平台前缀不再可见；
- 浏览器从 SPA HTML 请求 `/assets/app.js`、模块、redirect 和 API 时始终回到同一 Worker；
- 两个 Worker 的 cache、cookie、CORS、WebSocket 和 Static Assets request 不跨 origin；
- 发布 migration 的既有字节不变，新 migration 可在 release 数据上原子迁移并通过 restart/snapshot restore；
- real-workerd Gate 在支持的 macOS/Linux 和声明客户端矩阵通过，无残留 listener/process/临时文件；
- `cloudflare-compatibility.md`、deviation、website routing 文档和 release notes 与最终行为一致。

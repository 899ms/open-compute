# I81–94：Cloudflare API、SDK 与生命周期缺口收敛

状态：**planned**。本批次承接 GitHub issues
[#81](https://github.com/elliothux/open-compute/issues/81)、
[#84](https://github.com/elliothux/open-compute/issues/84)、
[#86](https://github.com/elliothux/open-compute/issues/86)、
[#88](https://github.com/elliothux/open-compute/issues/88)、
[#89](https://github.com/elliothux/open-compute/issues/89)、
[#91](https://github.com/elliothux/open-compute/issues/91)、
[#92](https://github.com/elliothux/open-compute/issues/92)、
[#93](https://github.com/elliothux/open-compute/issues/93) 和
[#94](https://github.com/elliothux/open-compute/issues/94)。目标是让已声明的 Cloudflare-compatible 管理面、
`@open-compute/sdk` 和 operator diagnostics 重新一致，不恢复已退役的 SDK 或给上游缺口伪造第二条官方协议。

## 1. 结论与边界

这九项中，`#94` 是 Cloudflare 公开管理 API 本身没有提供的生命周期，其余是当前
open-compute 已声明支持面内的缺口：

| Issue                    | 真实缺口                                                                                                                     | Day 1 处理                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `#81` Artifacts SDK      | Cloudflare 已公开 REST 合同，但官方 TypeScript SDK 尚无 resource；当前 open-compute SDK authority 也未收录这 18 个 operation | 保持官方 path 和 `client.artifacts` standard scope，增加固定的 observed-standard schema 与 first-party delegate |
| `#84` `worker_loader`    | Cloudflare Dynamic Workers 与 Wrangler 已支持，官方 SDK binding union 滞后                                                   | 只扩展 Version create 参数类型，继续使用官方 runtime delegate                                                   |
| `#86` R2 object list     | Cloudflare REST API 和官方 SDK 已支持，open-compute 服务端仍明确返回 unsupported                                             | 先实现服务端官方 wire contract，再由生成器暴露官方 `BaseObjects.list`                                           |
| `#88` upload diagnostics | `PlatformError` 在转为通用 v4 error 时丢失 operator 可见原因                                                                 | 只补共享错误边界的结构化日志，不改 Cloudflare wire response                                                     |
| `#89` Assets `File`      | Cloudflare OpenAPI/SDK 把 multipart part 生成为 `string`，底层 transport 实际支持 `File`                                     | 扩展 facade create 参数类型，不改 transport 或服务端                                                            |
| `#91` Loader dynamic env | Cloudflare 只允许 structured-clone value 与 Service Binding；直接转移 D1/KV/R2/Queue binding 不属于官方合同                  | 不扩展传输协议；补 capability、文档、稳定 `DataCloneError` 与 Service Binding 正向 Gate                         |
| `#92` Worker cleanup     | `force=true` 被拒绝，执行过的 Version 又被 generation retention 阻塞到 workerd 重启，导致删除生命周期无法闭合                | 实现 crash-safe force delete；必要时受控轮换 workerd generation，再原子释放全部历史 Version referrer            |
| `#93` observability upload | Cloudflare SDK 把嵌套 metadata 编码为 bracketed multipart fields，当前 adapter 只识别 `observability.enabled`                           | 补齐已声明的闭集字段；将 Script observability 与 Deployment 在最终发布事务中一起提交                  |
| `#94` D1 migrations      | Cloudflare 只在 Wrangler 提供 migration lifecycle，公开 D1 REST/SDK 没有 list/apply API；本地 engine 已有大部分语义               | 作为 `client.openCompute.d1.migrations` vendor extension；先收紧完整 chain 验证，再暴露现有 service authority       |

本批次不升级 Cloudflare OpenAPI、`cloudflare` npm 或 Wrangler pin，不恢复旧 API alias，不向 SDK 暴露
generic raw request。后续上游支持通过
[Cloudflare 上游刷新](references/cloudflare-upstream-refresh.md)协调替换当前的类型或 delegate，公开 node 与 method 不变。

## 2. `#81`：Artifacts 属于 standard scope，不属于 vendor extension

### 2.1 旧 `cloudflare-extension` 不恢复

历史 `packages/cloudflare-extension` 是一个 private package：`createOpenComputeExtension()` 接收已配置的
`BaseCloudflare`，手写 `get`/`post` wrapper，并从 `openapi/open-compute-extension.json` 生成 vendor types。P16 发布
[`@open-compute/sdk`](implemented/p16-capability-scoped-typescript-sdk.md) 时已直接删除该 package 和
`createOpenComputeExtension`，不保留 alias。

旧 package 不应恢复：

- 它会重新引入第二个 package、client composition 入口和公开类型 graph；
- 当前 `packages/sdk/scripts/generate.ts` 已经从同一 extension OpenAPI 生成 `client.openCompute`，并复用唯一
  `BaseCloudflare` transport；
- 恢复旧 package 不能解决 Artifacts 的 schema authority 和 standard surface 问题，只会产生双实现。

可以复用的是机制，不是旧 package：一份固定 OpenAPI authority、一个复用官方 transport 的 resource
delegate、一个 closed facade node、一份 surface report 和相同的 package/Gate 边界。

### 2.2 不放入 `client.openCompute`

Artifacts 管理路由是 Cloudflare 公开的
`/accounts/{account_id}/artifacts/...` 合同，不是 open-compute-only path。官方 TypeScript SDK 尚未生成
resource，不改变该 API 的身份。因此：

- 公开 SDK node 固定为 `client.artifacts`；
- 服务端继续使用官方 Artifacts path、v4 envelope、error code 和 binary response；
- `client.openCompute` 只保留 open-compute-only routes，不作为“官方 SDK 还没生成”的暂存区；
- 上游 SDK 将来提供 Artifacts 后，只替换内部 delegate，不迁移 public node，不保留双路径。

若当前证据不足以固定某个 Artifacts operation 的 request/response schema，该 operation 继续不出现在
SDK；不得通过放入 `openCompute` 来降低官方 path 的准入标准。

### 2.3 observed-standard authority

当前 18 个 Artifacts operation 只在 `cloudflare-subset-manifest.json` 的 `clientObservedOperations` 与 P6 capability
inventory 中，不在 `cloudflare-v4-subset.json` 或 `open-compute-sdk.json` 中。实现时增加一份独立的
**observed-standard OpenAPI overlay**，不修改或伪装 upstream Cloudflare OpenAPI snapshot。

该 overlay 必须：

- 记录 Cloudflare Artifacts REST docs 的固定抓取日期、Wrangler 4.127.1 evidence 和每个 operation/schema digest；
- 表达 namespace、repository、token、log/commit/tree 与 blob/file/raw 的 request/response；
- 明确 JSON envelope、pagination 和 binary response，对 token secret 字段单独标记；
- 只能收录已由 P14 服务端实现并有固定差分证据的 operation；
- 与 official subset 和 vendor extension 做 path/method/component 冲突检查，生成 combined SDK OpenAPI 时保留来源分类。

`cloudflare-subset-manifest.json` 继续只做选择与 evidence index，不兼任 schema 文件。

### 2.4 first-party delegate

在 `packages/sdk` 内增加一个 source-owned Artifacts resource delegate，直接复用已隐藏的
`BaseCloudflare` transport：

- JSON operations 使用官方 request/retry/auth/error machinery，只解包 v4 `result`；
- namespace/repository 与 token list 按已固定的 cursor/page contract 返回可迭代 pagination object；
- blob/file/raw 设置 binary response，不把 bytes 转成 JSON 或完整缓存；
- path segment 通过唯一的 strict encoder，raw file 的 path 保留分段语义，禁止 `.`/`..` 被 URL
  normalization 消费；
- token plaintext 只在 issue/create 响应类型中出现，不进入 logger、surface report 或 error message。

生成器的 delegate 选择顺序固定为：

1. pinned official SDK 的唯一 route match；
2. observed-standard overlay 显式登记的 first-party delegate；
3. 否则生成失败或继续显式 `sdkExcludedOperations`。

不建立通用 plugin/delegate DSL；Day 1 只需 Artifacts 这一个 first-party standard delegate。

## 3. `#84` 与 `#89`：最小 SDK signature override

这两项的 runtime method 仍由官方 SDK 实现，不新建 resource delegate。生成器增加一份有限的、
operation-keyed signature override table，只允许扩展已匹配官方 method 的 TypeScript 参数，不改 path、HTTP method、
response 或 runtime binding。

### 3.1 `#84` Worker Loader

`workers.scripts.versions.create` 保留官方全部 binding union，另增：

```ts
export type OpenComputeWorkerLoaderBinding = {
  readonly type: "worker_loader";
  readonly name: string;
};
```

facade 参数只把 `metadata.bindings` 扩展为 official binding 与该类型的 union。服务端已有
`WorkerUploadBinding::WorkerLoader`，不改 Rust model 或 workerd bridge。验收要求 positive compile fixture 无 cast
创建 Worker Version，并证明实际 multipart metadata 包含精确 `{type, name}`。

### 3.2 `#89` Static Assets upload

`workers.assets.upload.create` 的 body 扩展为：

```ts
export type OpenComputeAssetsUploadCreateParams = Omit<
  UploadCreateParams,
  "body"
> & {
  readonly body: Record<string, string | File>;
};
```

保留 `string` 以表达官方 SDK 已接受的无 per-part MIME 调用；需要正确静态资源
`Content-Type` 时必须传 `File`。验收不只检查 TypeScript，还要捕获官方 transport 产生的
`FormData`，确认 part 的 filename、base64 body 与 `File.type` 未丢失，并通过真实 asset serve 确认
HTML 不再被当成 `application/octet-stream`。

## 4. `#86`：先闭环 R2 List Objects 服务端

当前 v4 route 明确返回 `Unsupported`，manifest 也将
`GET /accounts/{account_id}/r2/buckets/{bucket_name}/objects` 列为 unsupported。因此不得先在 SDK
单独增加 `BaseObjects.list`。

服务端实现复用已有 `R2BindingService` list core 的 catalog、opaque cursor、prefix/delimiter/start-after、
metadata HEAD fan-out 和 provider reconciliation，但不复用 private Worker-binding HTTP response。共享层返回 typed page，
两个 adapter 各自编码 wire contract。

management adapter 必须：

- 先解析 account/bucket 并执行 read authority，不在未授权请求上查 catalog；
- 精确验证 `per_page`、`cursor`、`prefix`、`delimiter`、`start_after` 和 jurisdiction；
- 返回官方 `result: R2Object[]` 与 sibling `result_info`，其中包含 `cursor`、`delimited`、
  `is_truncated` 和 `per_page`；
- 把内部 upload millis 转为 `last_modified` ISO timestamp，把 SSE-C 映射为 boolean `ssec`；
- 不返回内部 `version`、`checksums`、`http_etag`、`range` 或 `ssec_key_md5`；
- cursor 继续绑定 account/resource generation、query digest 和 expiry，不把 provider key 暴露为 continuation token。

服务端成功、失败与 restart-safe tests 通过后，将 manifest 的该 operation 直接改为 `supported`，重新
生成 subset/capability/SDK。生成器将自然绑定 pinned official `BaseObjects.list`，不需要第二个客户端实现。

## 5. `#88`：保留 Cloudflare 错误外形，补 operator cause

Worker v4 handler 的共享 `platform_error(request_id, error)` 是唯一修复点。它在把 `PlatformError` 转为
`V4Error` 前写入一条结构化 operator event：

```text
request_id=<id>
platform_error_code=BUNDLE_INVALID
platform_error_message="Worker compatibility metadata is unsupported by the pinned runtime"
```

`PlatformError` 的 message 必须继续由 compile-time `&'static str` 限制为 secret-free operator text。不记录 multipart
body、module source、path、header、token 或 raw upstream exception。对外 response 继续是已固定的通用 Cloudflare v4
envelope，不暴露 platform code/message。

用户文档指向实际 SDK 字段
`(await client.openCompute.capabilities.get()).compatibility_date.maximum`；不新增问题中并不存在的
`runtime.effective_compatibility_date`。

验收同时断言错误 HTTP code/body 未变、operator event 包含 request ID 和稳定 cause，且日志通过
secret scanner。

## 6. `#93`：闭合 observability upload 的 transport 与发布事务

### 6.1 这是 adapter bug，不是 observability deviation

Cloudflare [Worker Script upload](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)
和 [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) 合同中的
`observability` 模型包含 `enabled`、`head_sampling_rate`、
`logs.enabled`、`logs.head_sampling_rate`、`logs.invocation_logs` 和 `logs.persist`。官方
TypeScript SDK 会把嵌套 metadata 递归编码为
`metadata[observability][logs][persist]` 形式的 multipart field。当前 Rust model、下游校验和
`worker_observability_settings` 都已支持这些字段，但 `sdk_multipart` 只重建
`observability.enabled`，其余官方 SDK 输入在进入 upload parser 前就被映射为通用 400。

修复保持 closed adapter：

- 显式重建已声明支持的上述 boolean 和 sampling-rate fields；
- 仍由现有 metadata validator 校验 finite `0..=1`，并拒绝非空 destinations 和已声明不支持的 traces；
- 对能识别但不支持的字段返回稳定 unsupported，不用 generic invalid 隐藏原因；
- 不实现通用 bracketed-object decoder，也不因为 Cloudflare 后续增加字段而默认放行未声明能力。

`OC-OBSERVABILITY-001` 只描述本地 retention、delivery、topology 和 query view 偏差，不授权拒绝上述
supported upload fields。

### 6.2 Script setting 与 Deployment 在同一最终发布事务提交

`observability` 是 Script-level mutable setting，不是 Version 内容。Cloudflare 的
`PUT /accounts/{account_id}/workers/scripts/{script_name}` 接受它，而当前固定的
`POST /accounts/{account_id}/workers/scripts/{script_name}/versions` request schema 不包含它。因此：

当前路径是两次独立提交：

```text
create Version + publish Deployment + switch active pointer  (commit A)
  -> update worker_observability_settings                    (commit B)
  -> return success
```

如果 `commit A` 已成功，但 `commit B` 失败或 `ocd` 在两者之间崩溃，API 会返回失败，
但新代码已经承接流量且仍使用旧日志策略。这是不可接受的部分成功。

目标路径将耗时和外部工作留在事务外，只把最终权威切换收入一个短事务：

```text
store bundle -> validate with workerd -> prepare product projections
  -> BEGIN IMMEDIATE
       insert Deployment
       switch Worker active pointer
       merge and update worker_observability_settings
       increment route_generation once
       write deployment + observability audits
     COMMIT
  -> return success
```

因此 final transaction 只有两种对外结果：成功时新代码和新日志策略同时可见；失败时
active Deployment 和 Script setting 都不变。事务前已完成验证的 immutable Version 可以保持
`ready` 但不 active；它不接收流量，可供重试复用或由现有 retention 回收，不属于部分发布。

- Script upload 将 metadata 解析为一个 closed `WorkerObservabilityPatch`，并纳入 version-create
  request fingerprint；
- 在 bundle 持久化、workerd validation 和产品 projection 预备全部成功后，最终
  `control.sqlite` publish transaction 同时插入 Deployment、切换 Worker active pointer、合并并更新
  `worker_observability_settings` 以及写入两条 content-free audit；
- patch 在该事务内与最新 Script setting 合并，Deployment 和 observability 只使
  `workers.route_generation` 增加一次；不先读出旧值后做两个独立事务；
- Queue/Cron promotion coordinator 只携带同一 patch 到现有 final deployment transaction，不建第二个
  observability saga；
- Version-only upload 出现 `observability` 时在管理边界失败，不得修改 Script setting。独立
  Script Settings PATCH 继续使用当前专用事务。

`WorkerObservabilityPatch` 只保留这次 upload 明确给出的字段，不在 parser 后立即读取并物化一份
可能过期的完整 setting。final transaction 读取当时最新的 setting，只覆盖 patch 中存在的字段；
这样不会把 upload 期间并发 Settings PATCH 的其他字段改回旧值。

不采用“先改 setting，upload 失败再回滚”：补偿会与并发 Settings PATCH 发生 ABA，且进程可在
回滚前崩溃。也不保留当前“Deployment 成功后再单独更新 setting”，因为它会产生失败响应下
已切换代码、但仍使用旧日志策略的部分成功状态。

验收覆盖官方 SDK 完整嵌套 multipart、数字/布尔边界、不支持字段、validation 失败不改
setting、publish transaction 前崩溃两者都不发布、commit 后重启两者都可见，以及
Version-only upload 不能修改 Script observability。真实 Worker 调用后还必须能按精确
`$workers.scriptVersion.id` 查到持久日志。

这项不需要修改 workerd 或增加 database migration；现有 table、generation 和 runtime snapshot
identity 已能表达所需状态，只需收敛 `ocd` 内的 transport、pipeline 和最终持久化边界。

## 7. `#94`：D1 migration lifecycle 作为 vendor management API

Cloudflare 公开 [D1 REST/SDK](https://developers.cloudflare.com/api/resources/d1/subresources/database/) 只提供
database CRUD、query/raw 和 import/export；[migration](https://developers.cloudflare.com/d1/reference/migrations/)
file 发现、unapplied list 和 apply 由 Wrangler 管理。因此本项不冒充 Cloudflare endpoint，也不放入
`client.d1.database`，而是增加：

```text
GET /accounts/{account_id}/open-compute/d1/databases/{database_id}/migrations
PUT /accounts/{account_id}/open-compute/d1/databases/{database_id}/migrations

client.openCompute.d1.migrations.list(...)
client.openCompute.d1.migrations.apply(...)
```

GET 使用 read permission；PUT 使用 product-write permission，并在解析受限 JSON body 前完成 account/resource
authority。请求只包含 `{id,name,sha256,sql}` 闭集字段，`sha256` 必须是 64 位小写十六进制；
handler 只转换 DTO 并调用 `D1BindingService::{migrations,apply_migrations}`，不复制 SQLite 或 ledger
逻辑。

当前 engine 已有 checksum、唯一 name/ID、下一连续 ID、SQLite tail-pointer、authorizer、串行 lane 和
尾部单事务 rollback，但还没有真正实现 issue 所说的“完整 ordered chain”：服务端已有
`1,2`时，请求只提交 `1` 会成功，提交 `1,3` 也可能把 `3` 当作新尾部。在开放 API 前直接收紧
唯一 engine 语义：

- 请求 ID 必须按输入顺序精确为 `1..N`；
- persisted ledger 必须是请求的精确前缀，ID、name 和 SHA-256 逐项一致；
- persisted ledger 比请求更长、请求删除历史项、重排、改名、改 SQL/hash 或产生 gap 都是 drift；
- 只执行尚未应用的精确尾部，所有 pending SQL 与 ledger rows 继续在一个 transaction 中提交。

HTTP 层将 `D1MigrationDrift` 显式映射为该 vendor operation 的稳定 `409 / 9100006`，不把内部
`PlatformError` message 或 SQLite 细节返回给客户端。同一完整 chain 重放返回当前 ledger，因此响应
丢失后不需要额外 idempotency key。

新增的 route tests 只证明 auth、body boundary、DTO/error mapping 和 service delegation；checksum、drift、多语句
rollback 和串行性继续由现有 engine/service tests 拥有，不在 HTTP 层复制同一套测试。补充一个
generated SDK typing/transport test 和一个重启后的完整 chain 重放 Gate。

## 8. `#91`：资源 Binding 通过 Service Binding 委派

`WorkerCode.env` 的 Cloudflare 合同只接受 structured-clone value 与 Service Binding，包括 `ctx.exports` loopback
binding。原生 D1、KV、R2 和 Queue binding 对象不能直接转移；open-compute 不为它们增加第二套私有序列化协议。

Loader Worker 应导出一个最小 `WorkerEntrypoint`，在宿主侧持有真实资源 binding，并只向 Dynamic Worker 委派所需方法：

```ts
import { WorkerEntrypoint } from "cloudflare:workers";

export class Storage extends WorkerEntrypoint<Env, { prefix: string }> {
  async get(key: string): Promise<string | null> {
    return this.env.KV.get(`${this.ctx.props.prefix}:${key}`);
  }
}

const worker = env.LOADER.get(buildHash, () => ({
  compatibilityDate: "2026-09-08",
  mainModule: "main.js",
  modules,
  env: {
    STORAGE: ctx.exports.Storage({ props: { prefix: tenantId } }),
  },
}));
```

这既与 Cloudflare 对齐，也把授权、租户前缀、可调用方法和审计留在 Loader Worker。D1、R2 与 Queue 使用相同模式，不直接暴露
完整宿主 binding。

实现只补产品表达和回归：

- capability 明确 `WorkerCode.env` 的 transfer boundary；
- 直接传入 D1/KV/R2/Queue binding 时，`load()`/`get()` 抛出稳定 `DataCloneError`；
- 通过 `ctx.exports` wrapper 委派相同资源时成功；
- 未捕获的 tenant exception 对外继续映射为通用 runtime error，具体 secret-free cause 由 `#88` 进入 operator log。

不能在 Worker upload 时拒绝这一输入，因为具体 `WorkerCode.env` 由 Loader Worker 在请求执行期间动态构造。

## 9. `#92`：闭合 Worker 与资源删除生命周期

当前问题由四部分组成：

1. Delete Worker operation 被声明为 supported，但 `force=true` 固定返回 unsupported；这是 Cloudflare 管理 API 对齐缺口。
2. Worker 一旦执行，Version 会因未知 `waitUntil()` 生命周期被保留到 workerd generation 结束；普通删除可能永久返回 409。
3. 历史 Version 保留资源 referrer 是正确的 immutable deployment 语义，不能让资源删除忽略它们。
4. R2 非空 bucket 的标准清空路径依赖 `#86` List Objects，不在 `#92` 另建 bulk-delete 私有 API。

Day 1 修复保持一条删除路径：

- 普通删除先停止新 admission，再 bounded drain；真实在途执行或入站 Service reference 仍返回 409。
- `force=true` 持久化 deletion intent 并 fence Worker；若存在 generation retention，则请求 supervisor 受控轮换唯一 workerd
  generation，旧 generation 退出后再继续。
- 数据库 transaction tombstone Worker、route 与 deployment authority，并释放该 Worker 所有历史 Version 的 D1/KV/R2/Queue、
  Workflow 和其他 outbound referrer；外部资源本身不随 Worker 删除。
- force 可以越过其他 immutable Version 对目标 Worker 的入站 Service reference；调用方 Version 不被改写，后续解析已删除目标时稳定
  fail closed。
- `ocd` 在 workerd 轮换与数据库提交之间崩溃时，从 deletion intent 恢复；不能留下永久 fenced Worker 或已释放一半的 referrer。

受控 generation 轮换会短暂影响同机其他 Worker，但它只用于显式 force delete，符合当前单机复杂度预算。暂不修改 workerd 增加逐
Worker `waitUntil()` drain acknowledgement；只有实际删除频率和可用性要求证明轮换不可接受时再做该原生协议。

验收至少覆盖普通删除 409、force 后成功、其他 Worker 在 generation 轮换后恢复、全部历史 Version referrer 释放、外部资源保留、
入站 Service target fail closed，以及每个 crash point 的幂等恢复。

## 10. 实施顺序

1. `#88`：先修复共享 diagnostic boundary，使后续真实 SDK/Gate 失败可定位。
2. `#93`：修复 official SDK multipart，并把 observability 收入最终 Deployment publish transaction。
3. `#86`：完成 R2 management list server contract，再打开 manifest 和 official delegate，为非空 R2 bucket 的标准清理提供前置能力。
4. `#92`：闭合 force delete、generation retention 与 crash recovery，并基于 `#86` 完成资源删除生命周期验收。
5. `#94`：收紧完整 D1 chain 语义，然后生成 vendor route 与 SDK node。
6. `#91`：固定 transfer boundary、错误与 Service Binding 正向/负向 Gate，不扩展运行时协议。
7. `#84` + `#89`：加入两个显式 signature overrides，不引入通用 override framework。
8. `#81`：增加 observed-standard authority 和唯一 Artifacts first-party delegate。
9. 在同一个 SDK/`ocd` 版本中重新生成、更新文档并发布，不发布只修类型的临时 package。

## 11. Authority 与验收

实现后的唯一权威链为：

```text
pinned official OpenAPI subset
  + pinned observed-standard overlay (Artifacts only)
  + open-compute vendor extension
  -> combined SDK OpenAPI
  -> closed SDK facade + surface report
```

三类 operation 必须在 machine-readable report 中显式标记 `official`、`observed_standard` 或
`open_compute_extension`，不得只从 node name 推断来源。`client.artifacts` 计入已声明的 Cloudflare-compatible standard
surface；`client.openCompute` operation 不计入 Cloudflare stable-member denominator。

实现阶段执行：

- generator byte drift、authority digest、path/component collision 与 runtime/type graph closure；
- SDK positive/negative compile fixtures，multipart MIME、pagination、binary response、retry/error 与 path encoding tests；
- R2 list 的 query/cursor/delimiter/metadata、provider failure、restart 与 bucket-delete lifecycle tests；
- Worker 普通/force delete、generation recycle、全部 referrer 释放和 crash recovery tests；
- Worker Loader dynamic env 的四类资源负向 transfer 与 Service Binding wrapper 正向 tests；
- Artifacts 18-route live-router contract，token redaction 和 repository lifecycle tests；
- upload diagnostic 的 stable response + operator cause + secret scan；
- official SDK observability multipart、Script upload 最终发布原子性、Version-only 负向输入和持久日志查询；
- D1 complete-chain drift/rollback、vendor route auth/error envelope、SDK transport 和重启后幂等重放；
- `cf-compatibility-check`、相关 focused checks、coverage，以及源码冻结后一次完整 workspace Gate。

文档完成不代表以上检查已通过。本文移入 `docs/implemented/` 时删除实施顺序和过程性细节，
只保留最终公开合同、authority 边界与实际验收证据。

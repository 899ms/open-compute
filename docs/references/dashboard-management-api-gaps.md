# Dashboard 管理 API 与 SDK 缺口

本页只讨论 OCD **明确支持**的产品能力：底层已有权威数据或操作，但 Cloudflare 风格 Dashboard 所需的管理面访问曾缺失或信息不足。原始审计发现九项，当前工作树已实现，**尚不等于最终 Gate 验收**。审计证据及页面消费关系见 [Dashboard 调研记录](../../dashboard-refactor/ocd-sdk-gap-audit.md)。当前支持范围仍以 [Cloudflare 兼容矩阵](cloudflare-compatibility.md)、机器可读合同和源码为准。

## 不是九个「SDK 层缺口」

SDK 从 OpenAPI 生成，是最终消费层。九项在 SDK 中都表现为缺方法或缺字段，但只有 **Worker service metadata** 原本已有完整 OCD HTTP 实现，属于纯 OpenAPI/SDK 漂移。其余八项必须先修正底层聚合、OCD 管理路由或响应投影，再更新 OpenAPI 与 SDK；只在 SDK 加方法无法取得真实数据。

| 原始缺口层 | 数量 | 典型问题 |
| --- | ---: | --- |
| OpenAPI / 生成 SDK 漂移 | 1 | HTTP 已可用，合同遗漏 |
| OCD 管理 API 缺失 | 5 | 底层可做，但浏览器没有受权的管理入口 |
| OCD 响应投影不足 | 2 | 已有路由丢失分页、状态或限制字段 |
| 底层聚合与 OCD API 均缺失 | 1 | 原始事件已留存，所需汇总查询尚未建立 |

### 九项逐项清单

“审计时”列记录原始缺口；“当前工作树”列记录本轮改动，不应读成已发布能力。下表的 `...` 均位于 `/accounts/{account}` 下；平台页同时使用 account-scoped open-compute 路由，避免多 instance 会话产生歧义。

| 能力与 Dashboard 用途 | 底层权威：审计时 | OCD HTTP：审计时 | OpenAPI / SDK：审计时 | 当前工作树的 HTTP → SDK 入口 |
| --- | --- | --- | --- | --- |
| Worker service metadata；Worker 概览/设置 | 已有 | 已有 handler | **缺合同与生成方法** | `GET .../workers/services/{script}` → `openCompute.workers.serviceMetadata` |
| Worker → Queue consumers；Worker 的队列消费者列表 | 已有按 Worker 反查 | **缺 Worker 视角路由** | 缺 | `GET .../workers/scripts/{script}/queue-consumers`（有界分页）→ `openCompute.workers.queueConsumers` |
| Observability usage；Workers/Observability 用量卡片 | 有留存事件和时间索引，**缺区间聚合** | **缺路由** | 缺 | `GET .../workers/observability/usage?from=&to=` → `openCompute.workers.observability.usage` |
| Durable Object catalog；namespace/object 表格 | 已有游标仓库及生命周期字段 | **已有路由但无界且丢字段** | 类型随投影缺字段 | `GET .../open-compute/durable-objects`、`GET .../open-compute/durable-objects/{namespace}/objects`（游标分页）→ `openCompute.durableObjects.list`、`.objects` |
| Workflow settings；列表/创建高级设置 | 已有验证后的保留期默认值 | **缺路由** | 缺 | `GET .../workflows/settings` → `openCompute.workflows.settings` |
| 公开产品/表单限制；创建/编辑校验 | 已有内部限制注册表 | **capabilities 响应缺 limits** | 类型缺字段 | `GET /open-compute/capabilities` 的 `limits` → `openCompute.capabilities.get` |
| D1 rename；数据库设置 | 已有通用资源重命名权威 | **缺 D1 管理路由** | 缺 | `PATCH .../open-compute/d1/databases/{database}/name` → `openCompute.d1.rename` |
| R2 multipart 管理上传；大文件对象上传 | 已有持久化 multipart 状态机 | **管理面仅有单次 PUT** | 缺 | `.../open-compute/r2/buckets/{bucket}/multipart-uploads` 下四个操作 → `openCompute.r2.multipart.create/uploadPart/complete/abort` |
| Queue consumer runtime；消费者运行状态卡片 | 已有无密钥调度器状态投影 | **缺路由** | 缺 | `GET .../open-compute/queues/{queue}/consumers/{consumer}/runtime` → `openCompute.queues.consumerRuntime` |

以上九项均按“权威数据/操作 → OCD HTTP → OpenAPI → 生成 SDK”的顺序补齐，并有对应的传输/合同测试。它们不需要 Dashboard 私有 fetch 封装。**这只关闭了原始九项审计清单；下文的历史指标仍缺底层权威，最终 Gate 也尚未验收。** D1 rename 是 open-compute 扩展：Cloudflare 官方 D1 更新请求不定义数据库名称，不能把 `name` 塞进官方请求体。Observability usage 只统计已留存日志事件，**不是**全部 Worker 请求数。

## 单 daemon 多 instance 的 Dashboard session 缺口已关闭

上游切换为一个 OCD daemon 管理多个 instance 后，共享监听器虽已能把 `/client/v4/accounts` 投影为 instance 列表，但原 Dashboard session 仍由各 instance 单独持有；多 instance 时 `/operator/session` 无法选择唯一目标，已签发的 session 也不能跨 instance 完成账户切换。这是 **OCD 共享路由与认证状态缺口，不是 SDK 缺口**。当前工作树把短期 Dashboard session 绑定到 daemon generation，并让所有运行中的 instance 复用同一认证状态；长期 admin token 仍只用于换取短期 session，不写入浏览器存储。聚焦 Rust 回归覆盖双 instance 签发 session 后列出全部账户，浏览器 E2E 覆盖左上角搜索、当前项标记、切换及刷新后 session 中 instance ID 更新。

## 后续发现并修复的纯 SDK 传输缺口

Cloudflare AI Search 的 Items → Upload files 对话框提供 **Choose a folder**。原 Cloudflare TypeScript SDK 的 `getName()` 会对所有上传名按 `/` 和 `\\` 取 basename：以 `File.name = "docs/probe.txt"` 调用其 `items.upload`，OCD 只收到 `probe.txt`。随后对**同一 OCD 路由**直接提交原生 multipart（`filename="docs/probe.txt"`），响应和列表都保留 `docs/probe.txt`，证明底层和 HTTP 已具备能力；缺口实际只在 SDK 传输层，前一版文档对此归因有误。 该修正针对本仓库固定的 `cloudflare` TypeScript SDK 7.1.0（`src/internal/uploads.ts#getName`）；官方 [Upload Item 合同](https://developers.cloudflare.com/api/resources/ai_search/subresources/namespaces/subresources/instances/subresources/items/methods/upload/) 仅要求 multipart 文件名不超过 128 字符，并未要求裁掉目录。它属于管理面传输，与 workerd 兼容日期/flags 无关；升级官方 SDK 后应重跑路径回归，再决定是否移除该窄修正。

| 页面操作 | 原始缺口所在层 | 当前工作树与验证 |
| --- | --- | --- |
| AI Search 内置存储上传文件夹并保留相对路径 | **Cloudflare SDK 的 multipart 文件名裁剪**；OCD HTTP 无须新增路由 | `@open-compute/sdk` 的同名 `items.upload` 在浏览器 `File.name` 含 `/` 时保留原始 multipart filename；普通文件继续委托官方 SDK。SDK 请求体单测和隔离 OCD 实例端到端验证通过：`docs/same.txt` 与 `other/same.txt` 成为两个不同 key。Dashboard 的原生文件夹选择、选中列表和 2/2 成功状态已按用户提供的实站截图实现并通过聚焦 e2e。实站 multipart 请求体仍未捕获，记录为证据边界，不阻塞该 UI。 |

## Worker 版本元数据绑定：OCD 持久化约束已修正

官方 [已加载 Add 表单](../../dashboard-refactor/screenshots/cloudflare/145-worker-version-metadata-binding-add.jpg)只要求变量名；未设置 Version tag 也可以创建。OCD 的 HTTP/SDK 已接受 `{type:"version_metadata",name}`，但已发布 V1 控制库约束强制 `version_metadata.tag IS NOT NULL`，导致正常的 Settings PATCH 返回 500 `VERSION_INVARIANT_VIOLATION`。这属于 **OCD 持久化模型缺口，不是 SDK 缺口**。当前工作树追加 V13 迁移，使版本元数据 tag 可空，同时仍要求 WASM/text/blob 模块绑定有 tag；保留已有行、唯一索引、名称/状态/不可变触发器。V12→V13 回归覆盖有 tag 的旧行、无 tag 新行及模块缺 tag/非法更新拒绝。隔离 OCD 浏览器 E2E 通过 Add/Edit/Delete、精确部署 Version 读回及 Images 同级绑定保留；最终全量 Gate 仍待实现冻结后执行。

## Durable Object 绑定：跨 Worker 选择仍是 OCD 能力缺口

2026-09-24 实站 [Durable Object 绑定资源下拉框](../../dashboard-refactor/screenshots/cloudflare/147-worker-do-binding-resource-options.jpg)列出了其他 Worker 导出的命名空间；[已选表单](../../dashboard-refactor/screenshots/cloudflare/148-worker-do-binding-selected.jpg)具有变量名、生产值和预览值。固定版 Cloudflare SDK 的 Settings binding 类型已包含 `durable_object_namespace`、`class_name` 和 `script_name`，因此**不是 SDK 缺字段**。OCD 的 Worker 上传与 Settings PATCH 目前只接受同一 Worker 已迁移的 class，明确拒绝 `script_name`；底层尚无跨 Worker Durable Object 绑定解析/授权/运行时接线。要完整复刻官方下拉框，须先扩展 OCD 的持久化解析和运行时能力，并加账户隔离及重启回归。当前 Dashboard 只能如实提供同 Worker class，不应展示其他 Worker 命名空间为可部署选项。独立 Preview 选择同样尚无 OCD 环境语义，不可伪装为已支持。详细布局和请求映射见 [表单规格](../../dashboard-refactor/research/components/worker-durable-object-binding.spec.md)；官方变更请求体未捕获。

同 Worker 绑定的端到端用例又暴露并关闭三项**不同层**的缺口。① 固定版官方 SDK 7.1.0 的 Worker Script `update` 把 migration `steps` 数组展开为无索引 multipart 名称，OCD 不可能无歧义还原多个 step；本地 SDK facade 仅在上传含 `migrations` 时以单个 JSON metadata part 提交，普通上传继续使用官方传输。② 浏览器 `Blob` 为该 JSON part 设置 `application/json;charset=utf-8`，OCD 原解析器只认无 charset；现在复用严格 JSON MIME 校验，仍拒绝 `text/plain` 和非 UTF-8 charset。③ Version 绑定投影错误地把 DO backing resource 的 UUID 名当作 `class_name`；现在从账户授权的 DO namespace 记录读取真实 class，`namespace_id` 保持原公开 ID。SDK 请求形状测试 19/19、Rust 聚焦 MIME/继承投影测试、隔离 OCD 浏览器 Add/Edit/Delete 及精确活动 Version 验证均通过。跨 Worker 和独立 Preview **仍未支持**，不能因为这三项修复而宣称官方 DO 表单完整等价。

## Dynamic Workers 绑定：SDK Settings 类型缺口已修正

官方 [已加载 Add 抽屉](../../dashboard-refactor/screenshots/cloudflare/146-worker-dynamic-workers-binding-add.jpg)只有变量名；[Cloudflare Dynamic Workers 文档](https://developers.cloudflare.com/dynamic-workers/api-reference/)将运行时能力称为 Worker Loader binding。OCD 已有原生 `worker_loader` 上传、Settings PATCH 克隆、持久化及运行时能力，但固定版 Cloudflare TypeScript SDK 7.1.0 的 Settings PATCH `bindings` 联合类型未列出 `worker_loader`。这次是 **SDK facade 类型缺口**，不是需要新增 OCD 路由或数据模型：当前生成器只对这项 Settings 操作扩展 `{type:"worker_loader",name}`，保持官方其余绑定类型，现有 JSON multipart 传输不变。SDK 类型编译与请求形状测试、隔离 OCD 浏览器 Add/Edit/Delete、精确活动 Version 读回及 Images 同级绑定保留均通过。官方 Dashboard 的实际 mutation 请求与移动版表单仍未观察；[本地截图及规格](../../dashboard-refactor/research/components/worker-dynamic-workers-binding.spec.md)明确这一证据边界。

## Service binding 高级 props：SDK Settings 类型缺口已修正

OCD 的同账户 Service binding 已支持目标 Worker、可选 named `entrypoint` 和 JSON 对象 `props` 的上传、Settings PATCH 克隆、持久化及版本投影。固定版官方 Cloudflare SDK 7.1.0 的 Settings `service` 类型包含 `entrypoint`，但不包含 `props`；若仅按其类型编辑已有 Service binding，会丢失已保存的 props。这是 **OCD 扩展字段的 SDK facade 类型缺口**，无需新管理路由：当前生成器仅对 Settings PATCH 的 Service binding 扩展 `props?: Record<string, unknown>`。SDK 类型编译和 multipart 请求体测试通过；隔离 OCD 浏览器用例验证了带嵌套 props 的目标改绑后，精确活动 Version 仍保留该对象。表单另校验 named entrypoint 格式和 JSON 对象/64 KiB 上限。官方 Service 表单及变更请求体未采集，因此[本地表单规格](../../dashboard-refactor/research/components/worker-service-binding.spec.md)不声称像素或请求逐项等价；有效 named entrypoint 的实际调用仍待单独端到端验证。

## 后续发现并修复的 Worker → AI Search 绑定缺口

官方 Worker Settings 的 [AI Search 实例绑定表单](../../dashboard-refactor/screenshots/cloudflare/143-worker-ai-search-binding-populated.jpg) 只提交 `instance_name`，不提交命名空间。OCD 已有 AI Search 实例及 Worker `ai_search` binding 类型，但内部资源名是 `{namespace_resource_id}:{instance_key}`；原 Worker 上传/Settings PATCH 按资源名直接比对 `instance_name`，因此实例真实存在时仍返回 400。版本响应也错误地回显内部复合名。这是 **OCD 绑定解析与投影缺口，不是 SDK 缺口**。

当前工作树改为用账户内 AI Search 实例权威记录的 `instance_key` 解析，并在版本中回显该公开实例名；若不同命名空间有同名实例，因为官方绑定字段无法指定命名空间，解析会拒绝歧义而不是任意选择。Dashboard 选择器同样不提供歧义项。命名空间绑定沿用已有 `namespace` 字段。两个表单的 Add/Edit/Delete 与逐次精确部署版本读回已通过隔离 OCD E2E；Rust 回归覆盖正常实例解析与跨命名空间同名拒绝。最终全量 Gate 与 CF 兼容性检查仍待完成。

## Playground 流式响应：SDK 原生能力已验证

Cloudflare 实站 AI Search instance Playground 的聊天请求是 `POST .../chat/completions`，`stream:true`，响应为 SSE：先有 `event: chunks` 来源，再有逐段 completion delta。OCD 的同一路由已支持流式响应。固定的官方 TypeScript SDK `instances.chatCompletions` 的 JSON 类型只描述 `await` 后的解析值：若直接 `await` 一个 SSE 请求会得到原始字符串，不能作为对象使用。不过其 `APIPromise.asResponse()` 可在响应未结束时返回原生 `Response`，然后读取 `response.body`；合成分段 SSE 测试中首段约 7 ms 到达，而尾段 200 ms 后才写入。因此**不存在需要新增 SDK 接口的传输缺口**。Dashboard 应复用同名 SDK 方法和 `asResponse()` 读取 SSE，不写私有 fetch；事件解码属于页面呈现逻辑，与 workerd 兼容日期/flags 无关。

## Queue 更新的合同语义已修正

2026-09-24 的 Queue 设置页复查发现，官方 [Queue PUT 更新合同](https://developers.cloudflare.com/api/resources/queues/methods/update/)明确说不支持部分更新，会用提交的配置覆盖原配置；官方 [PATCH 合同](https://developers.cloudflare.com/api/resources/queues/methods/edit/)则是更新 Queue。OCD 原来让两者共用合并语义，属于 **HTTP 行为缺口，不是 SDK-only 缺口**。当前工作树的 PUT 会将未提供的设置字段恢复为 Queue 默认值，PATCH 则保留未提供的字段；回归测试覆盖了替换与局部更新。省略 `queue_name` 时保留原名称，因为它是可选的资源标识字段，不属于 Queue 设置对象。Dashboard 的 `queues.update` 仍发送完整当前配置，避免行内编辑重置其他设置。生成 SDK 声明的子集仍只有 PUT、没有 PATCH；此操作不阻碍当前 Dashboard，但若对外承诺完整 Queue 管理 SDK，需单独补入 OpenAPI/生成 SDK。最终 CF 兼容性检查仍需复核服务器语义。

## D1 Time Travel 恢复窗口：稀疏检查点已投影，连续 PITR 仍不支持

Cloudflare D1 的 Time Travel 页显示连续可恢复窗口。OCD 的 `d1_coordinator.rs` 最多保留 **8 个显式完成历史点**，因此**不等价于 Cloudflare 的 7/30 天连续 PITR**；差异登记为 [`OC-D1-001`](cloudflare-compatibility.md#d1-time-travel-retention)。当前工作树新增账户授权的 `GET .../open-compute/d1/databases/{database_id}/time-travel/checkpoints`，从持久化权威返回全部仍保留的完成时间戳（空库返回空数组），并生成 `openCompute.d1.timeTravel.checkpoints(...)`。Dashboard 据此列出可选检查点，不把最早/最晚两点之间画成连续窗口，也不从数据库创建时间或固定“30 天”推断可恢复性。若将来承诺官方 PITR 语义，仍须先扩展底层留存/恢复模型并验证重启及清理。实站日期与书签表单证据见 [D1 Time Travel 调研](../../dashboard-refactor/research/components/d1-time-travel-interactions.md)。

验证：持久化空库/跨账户/多点测试、真实 D1 协调器八点清理测试、HTTP 空库与非空查询测试、生成 SDK 请求路径测试、OpenAPI 合同检查，以及独立 OCD 实例上的 D1 Time Travel Chrome E2E 均通过。页面点击检查点保留原始毫秒时间戳，避免本地日期输入格式化导致恢复到前一个历史点。

## R2 列表当前对象数与大小：已补当前值，旧对象大小仍可能未知

Cloudflare R2 桶列表在每行显示当前“对象”和“大小”（[实站截图](../../dashboard-refactor/screenshots/cloudflare/99-r2-overview-loaded-desktop.png)）。这个缺口不只是 SDK：已发布的控制库旧迁移只持久化对象身份，没有大小。新增不可变 V12 迁移给 `r2_objects` 添加可空 `size_bytes`，新的普通 PUT、覆盖写入和 multipart 完成在提供者确认后连同对象版本原子提交大小，删除从已提交集合移除。`R2ObjectRepository::bucket_usage` 只聚合当前已提交对象，不把待处理意图当成完成；空桶为 `0`/`0`。独立、账户授权的 `GET /client/v4/accounts/{account_id}/open-compute/r2/buckets/{bucket_name}/usage` 返回 `object_count` 和 `size_bytes`，OpenAPI 与生成 SDK 提供 `client.openCompute.r2.usage.get`；官方 `GET .../r2/buckets` 的响应结构保持不变。Dashboard 仅为当前页 10 个桶取用量，不扫描浏览器端对象列表。

V12 以前已提交对象没有可证明的大小，迁移**保留这些对象并将 `size_bytes` 留空**；只要桶中存在这样的记录，用量端点返回准确对象数、`size_bytes: null`，界面显示 `--`，不伪造 0。覆盖或删除这些对象后聚合可恢复为完整值。自动历史大小回填尚未实现；这是旧数据展示限制，不影响新写入的当前值，也不等同于下文仍缺的 R2 历史用量/时间序列。定向验证覆盖空桶、待提交 PUT、覆盖、删除、V11→V12 保留旧对象、HTTP 路由及 SDK 编码；最终仓库 Gate 仍待完整实现冻结后执行。

## 仍非 SDK 或薄 API 能补的缺口

下列是**仍未补齐、且不是 SDK 层缺口**：没有对应的完整底层权威，即使添加 SDK 方法也不能诚实呈现 Cloudflare 的图表。重建 Dashboard 时应标明 unavailable，不从现有当前值或采样日志推算历史数据：

| 缺口 | 缺少的底层能力 |
| --- | --- |
| Worker 请求数、CPU、错误率历史指标 | 始终开启且完整的 invocation 计量；留存 Logs 会受开关、采样、截断和过期影响 |
| KV namespace 历史指标 | 按 namespace 留存的读写/删除事件及时间序列；当前 key 列表和统计只能反映现状 |
| D1 查询次数、读写行数与历史图表 | 持久化的查询分析时间序列 |
| R2 历史用量/指标 | 持久化的聚合及时间序列；对象列表/HEAD 只给当前状态 |
| Durable Object 指标、部署及日志页 | namespace 级历史分析权威 |
| Queue 投递历史和日志图表 | 持久化的投递事件历史；当前只有调度器状态 |
| Workflow 历史指标图表 | 按 Workflow/时间维度留存的运行指标；当前实例、状态和事件 API 可用于实例页，但不能替代历史图表 |
| Vectorize 历史查询/用量图表 | 按索引留存的请求与用量时间序列；当前 index info 和向量操作不是历史分析 |
| AI Search Metrics 图表 | 按实例留存的文件状态、搜索类型和检索结果时间序列；当前 stats/jobs/items 仅支持现状与具体任务。进程级 `/metrics` 计数器不是可回溯、按实例查询的管理权威 |

Billing、计划/权益和全球分析等托管模块不在 OCD 声明的支持范围，不计入本次缺口。若以后决定支持上表某项，应先定义底层权威与留存语义，再依次补 OCD 路由、OpenAPI、生成 SDK、回归测试；不能仅扩展客户端类型。

## Worker Settings variables and bindings

[Cloudflare 官方 PATCH 合同](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/edit/)把 `settings.bindings` 列为 multipart 表单字段，用于修改 Worker 脚本及版本设置；具体替换/继承行为仍需实站请求或合同验证。

2026-09-24 的 [Worker Settings 完整加载及二级表单审计](../../dashboard-refactor/research/components/worker-settings-supported.spec.md)发现原九项之外的缺口：底层 `VersionController` 和 `UploadInput` 已能保存普通变量、JSON 及已支持产品绑定；权威 OpenAPI 与固定版 Cloudflare TypeScript SDK 的 `scriptAndVersionSettings.edit` 也已有 `settings.bindings`。缺的是 OCD HTTP 实现：原先 `PATCH .../workers/scripts/{script}/settings` 拒绝所有非空绑定列表。**这不是 SDK 缺口。**

当前工作树已把该 PATCH 接到不可变 Version 克隆流程：`bindings` 数组完整替换绑定集合，需保留的现有绑定须显式提交 `{"type":"inherit","name":"…"}`；省略 `bindings` 则保持原集合，空数组清空。普通变量、JSON、Secret 和已有产品资源复用上传路径的验证与账户授权；重复名称、未知类型、缺失继承目标及不带文件内容的模块绑定会拒绝。Secret 仍不由 GET 回显。现有真实进程 `w2_wrangler_limits_settings_clone_and_restart` 测试覆盖新增、继承、拒绝不存在的继承目标、清空和重启持久化，`bun run build`、Rust 编译通过；最终仓库 Gate 尚未执行。OpenAPI/SDK 的字段合同原已具备，无需增加新字段；后续仅修正了 facade 的 multipart 传输。官方 [PATCH 合同](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/edit/)包含 `settings.bindings` 和 `inherit` 类型，但实站 dashboard 变更请求仍未捕获；`network/04`、`network/68` 均是空记录，故完整替换语义仍待与实站逐项核对。相关 [完整页面](../../dashboard-refactor/screenshots/cloudflare/106-worker-settings-loaded-full.png)、[变量表单](../../dashboard-refactor/screenshots/cloudflare/107-worker-add-variable-loaded.png)、[KV 绑定表单](../../dashboard-refactor/screenshots/cloudflare/112-worker-kv-binding-form-loaded.png)可供实现对照。

浏览器端接线测试还发现固定版上游 SDK 会把 `settings.bindings` 序列化为 `settings[bindings][][type]` 等 multipart 文本字段，而 OCD 先前只接受单个 `settings` JSON part，导致 400。当前工作树让同一路由兼收单层绑定字段/CPU 限制的括号形式与 OpenAPI 声明的 `settings` JSON part，保留 1 MiB/字段数上限和未知字段拒绝。SDK facade 的 `scriptAndVersionSettings.edit` 现按 OpenAPI 发送单个 JSON part；后者保留嵌套 JSON 和空数组。浏览器生成的 `application/json;charset=utf-8` 已通过 Rust 解析回归与隔离 OCD 端到端测试。直接使用固定版上游 SDK 的复杂括号字段仍未逐类验证；Dashboard 使用的是修正后的 facade。

**已关闭的 SDK 传输缺口：清空最后一个绑定。** 固定版上游 SDK 的通用 multipart 展开器不会为 `settings.bindings=[]` 生成字段；不能把空表单解释成删除全部。当前 SDK facade 通过 `settings` JSON multipart part 明确表达空数组，SDK 请求形状测试覆盖空数组和嵌套 JSON，隔离 OCD 的浏览器回归 2/2 通过，最后一个变量删除后读回空表。原有[失败截图](../../dashboard-refactor/implementation-screenshots/worker-variable-final-binding-error.png)仅保留作诊断证据；[当前成功截图](../../dashboard-refactor/implementation-screenshots/worker-variable-final-binding-deleted.png)是视觉参考。

**保存/部署语义缺口已在当前工作树关闭。** 官方表单的“保存”创建一个未部署 Version；[实站版本历史](../../dashboard-refactor/screenshots/cloudflare/118-worker-variable-save-version-history.png)显示新版本 `6e262aa0…`，而部署仍指向 `e1d30220…`、流量 100%。重新加载官方设置页后该变量仍可见，而部署页仍显示旧 Version 承担 100% 流量。OCD 的 `PATCH .../settings` 现克隆最新 Ready Version，但不创建 Deployment；GET Settings 读取最新 Ready Version，线上请求仍使用活动 Deployment。连续设置变更因此继承上次未部署版本；随后通过独立 Secret/Cron API 部署时也从最新 Ready Version 克隆，避免丢掉已保存的设置。`w2_wrangler_limits_settings_clone_and_restart` 真实进程回归已验证版本递增、连续保存、活动部署不变、重启持久化及后续 Secret 部署保留设置。底层能力与既有 OpenAPI/SDK 字段均已具备，无需新端点；这不是 SDK 类型缺口。**推断边界：**官方 [PATCH 合同](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/edit/)描述设置更新会形成新 Version，但实站保存请求的精确 URL/body 仍未捕获，故不能把该路由选择当作已验证的 Cloudflare 网络请求等价性。Dashboard 现如实显示“Save version”，并在版本历史里单独确认提升；隔离浏览器回归验证请求提交的是被选中 Version 的完整 ID。

**KV 绑定的添加不是“仅保存”。** 2026-09-24 在保留的审计 Worker 上添加 `OCD_AUDIT_KV_20260924` 后，[官方部署页](../../dashboard-refactor/screenshots/cloudflare/125-worker-kv-binding-deployed-version-loaded.jpg)显示新 Version `0aa27113…` 承担 100% 流量；[干净加载的绑定表](../../dashboard-refactor/screenshots/cloudflare/126-worker-kv-binding-table-clean-loaded.jpg)显示真实命名空间链接及编辑/删除操作。当前本地 KV 绑定编辑器用既有 SDK Settings PATCH 保存版本、从前后完整 Version 列表唯一定位新增 ID，再读取该 Version 验证 KV 绑定并以该**完整 ID**创建 100% Deployment。不能唯一定位或读回不符时不部署。隔离 OCD 端到端用例覆盖 Add/Edit/Delete 三次精确版本核对、namespace 保留及 390px 无横向溢出；其他资源绑定类型仍需逐类实现。实站的精确变更请求未被 Chrome 捕获，因此这条本地调用链尚不能宣称与官方 Dashboard 网络请求逐项相同。

**R2 Worker 绑定已接入同一条经过核验的部署路径。** [官方 R2 Add 抽屉](../../dashboard-refactor/screenshots/cloudflare/129-worker-r2-binding-create-loaded.jpg)是右侧全高表单，与 KV/D1 的居中 Add 弹窗不同。当前 Dashboard 通过既有 `r2.buckets.list` 选择桶，用 Settings PATCH 的 `r2_bucket.bucket_name` 创建/修改不可变 Version，读回验证后才部署唯一新增的完整 Version ID；删除绑定不会删除桶。隔离 OCD 端到端测试用两个临时桶覆盖 Add/Edit/Delete、活动 Version 读回、桶保留和 390px 宽度；临时资源已清理。此处无需新增 OCD/SDK 字段。官方 R2 Edit/Delete 与变更请求体尚未采集；D1 和其他已支持绑定的编辑 UI 仍待实现。

这条用例还发现一个**OCD HTTP 分页缺口，并非 SDK 类型缺口**：此前 `GET /versions?deployable=true` 忽略 `page`，无论翻到第几页都重复非空结果；固定版 Cloudflare SDK 的 `V4PagePagination` 以空页结束异步迭代，因而会无限请求。当前工作树让 deployable 列表与普通列表一样遵守 `page`/`per_page` 并在末页后返回空 `items`。聚焦 Rust 测试验证 1、2、3 页及元数据，隔离 OCD 浏览器用例现在能完整迭代并通过。无需新增 OpenAPI 字段或 SDK 方法；最终仓库 Gate 尚未执行。

**已关闭的 OCD 注解缺口。** 同一官方 Settings PATCH 合同支持 `workers/message` 与 `workers/tag`，且注解不会自动继承。先前 OCD 拒绝非空 `annotations`，虽然不可变 Version 权威已能保存；当前工作树将其接入 PATCH 和 GET 响应，按官方字节上限处理 message/tag，并拒绝客户端伪造只读的 `workers/triggered_by`。真实进程回归验证仅改注解会新建未部署 Version、非法请求不改变最新版本、重启后注解仍在。官方 [Version list 合同](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/list/)只公开 ID/元数据/序号，不含注解；固定版 SDK 的 list/get 类型没有 `annotations` 是正确合同，并非 SDK 缺口。Dashboard 通过已定义类型的最新 Settings 响应显示最近一次保存消息；历史消息不由公开列表接口承诺。

**D1 Worker 绑定字段合同。** [官方 Settings PATCH 类型](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/edit/)要求 `database_id`，并把 `id` 标为已弃用；但[官方 multipart 上传示例](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/)仍使用 `id`。此前 OCD JSON Settings PATCH 只接受 `id`，且 Settings GET 只返回 `id`，官方 SDK 的 `database_id` 绑定无法直接回填。当前工作树将 `database_id` 作为唯一输出字段，输入仅对这两种有官方依据的字段名接受其一，同时拒绝两者并存；这是 OCD HTTP/投影缺口，**不是 SDK 类型缺口**。聚焦单元测试以及真实进程 `w2_wrangler_limits_settings_clone_and_restart` 已通过，后者覆盖新增 D1、Settings 读回、重启保留和 Secret 更新后的继承；最终仓库 Gate 待验证。

## 不需要新增 API 的已支持页面

KV 的 namespace/key 操作、D1 的查询/导入导出/迁移、R2 小对象浏览、Queue 配置与 **Worker 消费者** CRUD、Workflow 定义与实例、Vectorize 索引/向量、AI Search namespace/instance/job/item，以及 Worker 的代码、部署、绑定读取、Secret、Cron 和部分设置，已有相应管理合同与 SDK 方法；普通变量和产品绑定的独立 Settings 变更除外，见上节。D1 按名称创建也已有完整 HTTP/SDK 入口；官方创建页的 `primary_location_hint` 和 `jurisdiction` 虽能被 OCD 解析，却被 handler 明确返回 `Unsupported`，自托管实例没有相应区域/管辖权调度能力，不能将这两个选择伪装成可提交的 Dashboard 控件。R2 按名称创建同样已有完整入口，但 `locationHint`、非默认管辖权和 `InfrequentAccess` 存储类会被 OCD 拒绝；当前只有默认位置与 `Standard`，不能呈现可提交的区域/管辖权/低频访问选择。Queue `http_pull` 消费者虽出现在上游类型与官方表单，当前 OCD handler 同样明确返回 `Unsupported`，不能显示可提交的 HTTP pull 入口。页面设计应复用真正可用的入口；不要把 Cloudflare Dashboard 额外发出的请求逐个复制为 OCD 路由。详细能力边界见 [原始审计](../../dashboard-refactor/ocd-sdk-gap-audit.md#no-api-addition-needed)。

R2 小对象上传的 MIME 类型也不是新 API 缺口。固定版 Cloudflare TypeScript SDK 的 `objects.upload` 默认发送 `Content-Type: application/octet-stream`，但其 `RequestOptions.headers` 可覆盖；OCD 的同名 PUT 已持久化该 HTTP metadata。Dashboard 现以浏览器文件的 `File.type` 覆盖该头，隔离实例 e2e 验证 `text/plain` 在对象列表与独立详情预览中保留。文件夹递归删除和批量选择同样不是 SDK/API 缺口：Dashboard 现用既有 list/delete API 完整分页列出所选文件夹的所有精确键，校验前缀和游标，再逐项删除；隔离实例 e2e 验证嵌套对象被删除且未选择的同桶对象保留。中途失败会刷新列表并显示错误；故障路径 e2e 中断文件夹列举后确认所有对象原封未动，恢复请求后重试成功。

# I87：Git thin-pack push

状态：**blocked**。GitHub `#87` 等待上游 gitserver
[PR #18](https://github.com/WJQSERVER/gitserver/pull/18) 合并；合并前不在 open-compute 内维护 fork、vendor patch 或客户端规避路径。

## 阻塞证据

当前 `gitserver-core` pin 在 receive-pack 落盘时没有提供可解析既有仓库对象的 resolver，因此第二次及后续 push 中引用 remote-only
delta base 的合法 thin pack 会失败。上游 PR #18 正在修复同一根因。

这不是 Cloudflare Artifacts API 合同缺口，也不是 HTTP transport 问题；它是当前 Git smart-HTTP 后端的 pack resolution 缺口。
要求客户端关闭 thin pack 会改变标准 Git 行为，不能作为产品修复。

## 恢复条件

PR #18 合并后：

1. 审查合并后的 API 与安全边界，更新 workspace 中 `gitserver-core` 的 immutable revision；
2. 保持现有 Artifacts authority、鉴权和 smart-HTTP surface 不变，不增加兼容分支；
3. 增加真实仓库回归：首次 push 后修改既有 blob，再执行会引用 remote-only delta base 的后续 push；
4. 同时验证 clone/fetch、拒绝未授权写入、失败不更新 ref，以及 daemon restart 后仓库仍可读取。

完成以上验收后关闭 `#87`，并将本文移入 `docs/implemented/`。

返回[阻塞设计索引](README.md)。

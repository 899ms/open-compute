# @open-compute/sdk

Capability-scoped Cloudflare-compatible management SDK for
[open-compute](https://open-compute.dev) (`ocd`). The package exposes exactly
the operations that `ocd` has qualified against the pinned official Cloudflare
OpenAPI snapshot, plus open-compute-only operations under `client.openCompute`.
Every standard method delegates to the pinned official
[`cloudflare`](https://www.npmjs.com/package/cloudflare) SDK implementation, so
authentication, retries, pagination, multipart uploads, and error parsing match
the official client exactly.

## Installation

```sh
npm install @open-compute/sdk
```

Pair the SDK major.minor.patch with the same `ocd` release version.

## Usage

```ts
import { createOpenComputeClient } from "@open-compute/sdk";

const client = createOpenComputeClient({
  apiToken: process.env.OPEN_COMPUTE_API_TOKEN!,
  baseURL: "https://compute.example/client/v4",
});

await client.workers.scripts.versions.list("app", { account_id });
await client.d1.database.list({ account_id });
await client.openCompute.system.status();
```

`baseURL` is mandatory and must be an absolute URL whose canonical path ends in
`/client/v4`; plain HTTP is only accepted for loopback test addresses. The
client never reads ambient credential environment variables and never sends
requests to `api.cloudflare.com`.

## Surface

- The complete operation inventory (including deviations and the delegate
  mapping to official SDK methods) is recorded in the repository surface
  report committed next to the generator under `packages/sdk/surface.json`.
- open-compute-only operations (scheduler, cache, backups, upgrade checks,
  durable object inventory, worker endpoints) are available under
  `client.openCompute` only.
- Operations that `ocd` supports but the pinned official SDK does not
  implement are deliberately not exposed.

## Errors

Failures throw the official SDK error classes
(`APIError` and its subclasses), re-exported from this package.

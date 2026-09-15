import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { APIError } from "cloudflare";
import { createOpenComputeClient } from "../src/index.ts";

const repoRoot = new URL("../../..", import.meta.url).pathname;

async function mockClient(overrides = {}) {
  const requests = [];
  const responses = overrides.responses ?? [];
  const client = createOpenComputeClient({
    apiToken: "test-token",
    baseURL: "https://compute.example/client/v4",
    maxRetries: 0,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      const response = responses.shift();
      if (response !== undefined) return response;
      return new Response(
        JSON.stringify({ success: true, result: {}, errors: [], messages: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    ...overrides.options,
  });
  return { client, requests };
}

test("surface report, combined OpenAPI, and extension authority agree", async () => {
  const surface = JSON.parse(
    await readFile(new URL("../surface.json", import.meta.url), "utf8"),
  );
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const extension = JSON.parse(
    await readFile(
      new URL("../../../openapi/open-compute-extension.json", import.meta.url),
      "utf8",
    ),
  );
  const combined = JSON.parse(
    await readFile(
      new URL("../../../openapi/open-compute-sdk.json", import.meta.url),
      "utf8",
    ),
  );
  const vendorOperations = Object.entries(extension.paths).flatMap(
    ([path, methods]) =>
      Object.entries(methods)
        .filter(([method]) => method !== "parameters")
        .map(([method, operation]) => ({
          method: method.toUpperCase(),
          path,
          sdkMethod: operation["x-open-compute-sdk-method"],
        })),
  );
  assert.equal(surface.schemaVersion, 1);
  assert.equal(surface.package, "@open-compute/sdk");
  assert.equal(surface.packageVersion, packageJson.version);
  assert.equal(surface.operations.length, 140);
  assert.equal(surface.excludedOperations.length, 1);
  const byNode = (list) =>
    [...list].sort((left, right) => left.node.localeCompare(right.node));
  assert.deepEqual(
    byNode(surface.openComputeOperations),
    byNode(
      vendorOperations.map(({ method, path, sdkMethod }) => ({
        node: `openCompute.${sdkMethod}`,
        method,
        path,
      })),
    ),
  );
  assert.equal(
    combined["x-open-compute-sdk"].surfaceDigest,
    surface.surfaceDigest,
  );
  const combinedStandard = Object.entries(combined.paths).flatMap(
    ([path, methods]) =>
      Object.entries(methods)
        .filter(([method]) => method !== "parameters")
        .map(([method]) => `${method.toUpperCase()} ${path}`),
  );
  assert.deepEqual(
    combinedStandard.sort(),
    [
      ...surface.operations.map((operation) => operation.operation),
      ...vendorOperations.map(({ method, path }) => `${method} ${path}`),
    ].sort(),
  );
});

test("runtime surface walk equals the generated surface graph", async () => {
  const surface = JSON.parse(
    await readFile(new URL("../surface.json", import.meta.url), "utf8"),
  );
  const { client } = await mockClient();
  const runtime = [];
  const walk = (node, path) => {
    for (const [name, value] of Object.entries(node)) {
      if (typeof value === "function") runtime.push(`${path}.${name}`);
      else if (value !== null && typeof value === "object")
        walk(value, `${path}.${name}`);
    }
  };
  walk(client, "");
  const expected = [
    ...surface.operations.map(
      (operation) => `.${operation.node}.${operation.officialMethod}`,
    ),
    ...surface.openComputeOperations.map((operation) => `.${operation.node}`),
  ].sort();
  assert.deepEqual(runtime.sort(), expected);
});

test("standard and vendor methods issue official transport requests", async () => {
  const { client, requests } = await mockClient({
    responses: [
      new Response(
        JSON.stringify({
          success: true,
          result: [{ id: "v1", number: 1 }],
          errors: [],
          messages: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      new Response(
        JSON.stringify({
          success: true,
          result: { state: "running" },
          errors: [],
          messages: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ],
  });
  const versions = await client.workers.scripts.versions.list("app", {
    account_id: "acc-1",
  });
  assert.equal(versions.result[0]?.number, 1);
  const status = await client.openCompute.system.status();
  assert.equal(status.state, "running");
  assert.deepEqual(
    requests.map(({ url, init }) => ({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
    })),
    [
      {
        url: "https://compute.example/client/v4/accounts/acc-1/workers/scripts/app/versions",
        authorization: "Bearer test-token",
      },
      {
        url: "https://compute.example/client/v4/open-compute/system/status",
        authorization: "Bearer test-token",
      },
    ],
  );
});

test("vendor methods encode path segments and unwrap the v4 envelope", async () => {
  const { client, requests } = await mockClient();
  await client.openCompute.backups.kv.create("acc/1", "ns");
  assert.equal(
    requests[0].url.endsWith(
      "/accounts/acc%2F1/open-compute/kv/namespaces/ns/backups",
    ),
    true,
  );
});

test("official APIError envelope is preserved", async () => {
  const { client } = await mockClient({
    responses: [
      new Response(
        JSON.stringify({
          success: false,
          result: null,
          errors: [{ code: 10000, message: "authentication error" }],
          messages: [],
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    ],
  });
  await assert.rejects(
    () => client.openCompute.system.status(),
    (error) => {
      assert.ok(error instanceof APIError);
      assert.equal(error.status, 401);
      return true;
    },
  );
});

test("official retry behavior is preserved through the facade", async () => {
  const requests = [];
  const { client } = await mockClient({
    options: { maxRetries: 1 },
    // mockClient pushes every request; retry happens inside the transport.
  });
  const fetchCalls = [];
  const retryClient = createOpenComputeClient({
    apiToken: "test-token",
    baseURL: "https://compute.example/client/v4",
    maxRetries: 1,
    fetch: async (url, init) => {
      fetchCalls.push(String(url));
      if (fetchCalls.length === 1) return new Response("boom", { status: 500 });
      return new Response(
        JSON.stringify({ success: true, result: {}, errors: [], messages: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  await retryClient.openCompute.system.status();
  assert.equal(fetchCalls.length, 2);
  assert.equal(requests.length, 0);
});

test("request timeout surfaces as the official APIConnectionTimeoutError", async () => {
  const { APIConnectionTimeoutError } = await import("cloudflare");
  const client = createOpenComputeClient({
    apiToken: "test-token",
    baseURL: "https://compute.example/client/v4",
    timeout: 50,
    maxRetries: 0,
    fetch: (url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal.reason),
        );
      }),
  });
  await assert.rejects(
    () => client.openCompute.system.status(),
    (error) => error instanceof APIConnectionTimeoutError,
  );
});

test("client construction validation matrix", () => {
  const valid = {
    apiToken: "test-token",
    baseURL: "https://compute.example/client/v4",
  };
  const fetch = async () => new Response("{}");
  assert.ok(createOpenComputeClient({ ...valid, fetch }));
  assert.ok(
    createOpenComputeClient({
      ...valid,
      baseURL: "http://127.0.0.1:18787/client/v4",
      fetch,
    }),
  );
  assert.ok(
    createOpenComputeClient({
      ...valid,
      baseURL: "http://[::1]:18787/client/v4",
      fetch,
    }),
  );
  const invalid = [
    { ...valid, apiToken: "" },
    { ...valid, apiToken: "  " },
    { ...valid, apiToken: "bad\n" },
    { ...valid, baseURL: "compute.example/client/v4" },
    { ...valid, baseURL: "https://compute.example/other/v4" },
    { ...valid, baseURL: "https://compute.example/client/v4?x=1" },
    { ...valid, baseURL: "https://user:pw@compute.example/client/v4" },
    { ...valid, baseURL: "https://compute.example/client/v4#frag" },
    { ...valid, baseURL: "http://compute.example/client/v4" },
    { ...valid, baseURL: "ftp://compute.example/client/v4" },
    { ...valid, defaultHeaders: { authorization: "Bearer other" }, fetch },
    {
      ...valid,
      defaultHeaders: { "X-Open-Compute-Internal": "1" },
      fetch,
    },
  ];
  for (const options of invalid) {
    assert.throws(
      () => createOpenComputeClient(options),
      (error) => error instanceof Error,
      JSON.stringify(options),
    );
  }
});

test(
  "unsupported surface stays unreachable in compiled consumers",
  { timeout: 300_000 },
  () => {
    const tsc =
      process.env.OPEN_COMPUTE_SDK_TSC ?? "../../node_modules/.bin/tsc";
    const fixtures = [
      { file: "unsupported-top-level.ts", symbol: "aiGateway" },
      { file: "unsupported-sibling.ts", symbol: "search" },
      { file: "unsupported-leaf.ts", symbol: "bulkUpdate" },
      { file: "raw-generic-request.ts", symbol: "get" },
    ];
    for (const { file, symbol } of fixtures) {
      const result = spawnSync(
        tsc,
        [
          "--noEmit",
          "--strict",
          "--target",
          "es2024",
          "--module",
          "preserve",
          "--moduleResolution",
          "bundler",
          "--allowImportingTsExtensions",
          "--types",
          "node",
          `${repoRoot}packages/sdk/tests/negative/${file}`,
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );
      assert.notEqual(
        result.status,
        0,
        `negative fixture ${file} unexpectedly compiled: ${result.stdout}`,
      );
      assert.match(`${result.stderr}${result.stdout}`, new RegExp(symbol));
    }
  },
);

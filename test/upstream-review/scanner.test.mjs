import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { classify } from "./scanner.ts";

// Classification fixtures: small synthetic OpenAPI snapshots, manifests, and
// SDK route closures prove the three-way classification rules offline.

const REVISION_A = "a".repeat(40);
const REVISION_B = "b".repeat(40);

function schemaDocument(paths, suffix = "") {
  return {
    openapi: "3.0.3",
    info: { version: "4.0.0" },
    paths: Object.fromEntries(
      paths.map((path) => [
        path,
        { get: { operationId: `op-${path}${suffix}` } },
      ]),
    ),
  };
}

function schemaBytes(suffix = "") {
  return Buffer.from(
    `${JSON.stringify(schemaDocument(["/accounts/{account_id}/queues"], suffix))}\n`,
  );
}

const manifest = {
  schemaVersion: 1,
  statusVocabulary: [
    "supported",
    "supported_with_deviation",
    "planned",
    "unsupported",
  ],
  operations: ["GET /accounts/{account_id}/queues"],
  deferredOperations: [],
  unsupportedOperations: [],
  sdkExcludedOperations: [],
};

function operationDigest(operationId) {
  return createHash("sha256")
    .update(`${JSON.stringify({ operationId })}\n`)
    .digest("hex");
}

function fixtureInput(overrides = {}) {
  const schemaBytesValue = schemaBytes();
  const candidateRoutes = new Map([
    [
      "GET /accounts/{}/queues",
      ["resources/queues/queues.mjs::BaseQueues::list"],
    ],
  ]);
  return {
    baseline: {
      openapiRevision: REVISION_A,
      openapiSha256: "1".repeat(64),
      cloudflareSdkVersion: "7.1.0",
      wranglerVersion: "4.127.1",
    },
    candidateSchema: { revision: REVISION_A, bytes: schemaBytesValue },
    candidateCloudflare: {
      version: "7.1.0",
      npmShasum: "0".repeat(40),
      npmIntegrity: "sha512-",
    },
    candidateWrangler: {
      version: "4.127.1",
      npmShasum: "0".repeat(40),
      npmIntegrity: "sha512-",
    },
    candidateSdkRoutes: candidateRoutes,
    manifest,
    sdkExcludedOperations: [],
    baselineMappedOperations: ["GET /accounts/{account_id}/queues"],
    baselineInventory: [
      {
        id: "GET /accounts/{account_id}/queues",
        operationSha256: operationDigest("op-/accounts/{account_id}/queues"),
      },
    ],
    selectedOperations: ["GET /accounts/{account_id}/queues"],
    ...overrides,
  };
}

test("identical upstream identities classify as unchanged", () => {
  const report = classify(fixtureInput());
  assert.equal(report.classification, "unchanged");
  assert.deepEqual(report.changedOperations, []);
  assert.deepEqual(report.removedOperations, []);
});

test("a schema move covered by a moved official SDK is ready", () => {
  const changed = schemaBytes("queues-moved");
  const report = classify(
    fixtureInput({
      candidateSchema: { revision: REVISION_B, bytes: changed },
      baselineInventory: [
        {
          id: "GET /accounts/{account_id}/queues",
          operationSha256: operationDigest("op-/accounts/{account_id}/queues"),
        },
      ],
      candidateCloudflare: {
        version: "7.2.0",
        npmShasum: "0".repeat(40),
        npmIntegrity: "sha512-",
      },
    }),
  );
  assert.equal(report.classification, "ready");
  assert.deepEqual(report.changedOperations, [
    "GET /accounts/{account_id}/queues",
  ]);
});

test("a schema move without a published SDK move stays blocked on the SDK", () => {
  const changed = schemaBytes("queues-moved");
  const report = classify(
    fixtureInput({
      candidateSchema: { revision: REVISION_B, bytes: changed },
      baselineInventory: [
        {
          id: "GET /accounts/{account_id}/queues",
          operationSha256: operationDigest("op-/accounts/{account_id}/queues"),
        },
      ],
    }),
  );
  assert.equal(report.classification, "blocked");
  assert.deepEqual(report.waitingOn, [
    "official cloudflare SDK stable release",
  ]);
});

test("a removed selected operation is breaking", () => {
  const report = classify(
    fixtureInput({
      candidateSchema: {
        revision: REVISION_B,
        bytes: Buffer.from('{"paths":{}}'),
      },
    }),
  );
  assert.equal(report.classification, "breaking");
  assert.deepEqual(report.removedOperations, [
    "GET /accounts/{account_id}/queues",
  ]);
});

test("a baseline-mapped operation lost from the candidate SDK is breaking", () => {
  const report = classify(
    fixtureInput({
      candidateSchema: { revision: REVISION_B, bytes: schemaBytes() },
      candidateCloudflare: {
        version: "7.2.0",
        npmShasum: "0".repeat(40),
        npmIntegrity: "sha512-",
      },
      candidateSdkRoutes: new Map(),
    }),
  );
  assert.equal(report.classification, "breaking");
  assert.match(
    report.reasons.join(" "),
    /no longer implements mapped operations/,
  );
});

test("a wrangler-only move stays blocked on coordinated evidence", () => {
  const report = classify(
    fixtureInput({
      candidateWrangler: {
        version: "4.131.2",
        npmShasum: "0".repeat(40),
        npmIntegrity: "sha512-",
      },
    }),
  );
  assert.equal(report.classification, "blocked");
  assert.match(report.reasons.join(" "), /wrangler pin move/);
});

test("manifest-excluded operations do not force blocked or breaking", () => {
  const report = classify(
    fixtureInput({
      candidateCloudflare: {
        version: "7.2.0",
        npmShasum: "0".repeat(40),
        npmIntegrity: "sha512-",
      },
      candidateSdkRoutes: new Map(),
      sdkExcludedOperations: ["GET /accounts/{account_id}/queues"],
      baselineMappedOperations: [],
    }),
  );
  assert.equal(report.classification, "ready");
});

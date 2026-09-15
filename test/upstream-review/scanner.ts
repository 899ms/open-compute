// Cloudflare upstream refresh scanner: read-only discovery and three-way
// classification of the OpenAPI snapshot, official TypeScript SDK, and
// Wrangler identities against the repository pin.
//
// The scanner is shared by local review and the scheduled workflow. It only
// ever writes downloads and reports under `.temp/upstream-review/`, never
// executes package lifecycle scripts, and holds no publish credentials.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanOfficialPackage } from "../../packages/sdk/scripts/sdk-scan.ts";
import { buildSubset } from "../conformance/p6-contract.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REVIEW_ROOT = resolve(REPO_ROOT, ".temp/upstream-review");
const MANIFEST_PATH = join(
  REPO_ROOT,
  "openapi/cloudflare-subset-manifest.json",
);
const SUBSET_PATH = join(REPO_ROOT, "openapi/cloudflare-v4-subset.json");
const LOCK_PATH = join(
  REPO_ROOT,
  "openapi/upstream/cloudflare-openapi.lock.json",
);

export type Classification = "unchanged" | "ready" | "blocked" | "breaking";

export interface NpmIdentity {
  version: string;
  npmShasum: string;
  npmIntegrity: string;
}

export interface UpstreamReport {
  schemaVersion: 1;
  classification: Classification;
  generatedAtUtc: string;
  baseline: {
    openapiRevision: string;
    openapiSha256: string;
    cloudflareSdkVersion: string;
    wranglerVersion: string;
  };
  candidate: {
    openapiRevision: string | null;
    openapiSha256: string | null;
    cloudflareSdk: NpmIdentity | null;
    wrangler: NpmIdentity | null;
  };
  selectedOperations: number;
  changedOperations: string[];
  removedOperations: string[];
  unmappedOperations: string[];
  waitingOn: string[];
  reasons: string[];
}

export interface ScanInput {
  baseline: {
    openapiRevision: string;
    openapiSha256: string;
    cloudflareSdkVersion: string;
    wranglerVersion: string;
  };
  candidateSchema: { revision: string; bytes: Buffer };
  candidateCloudflare: NpmIdentity;
  candidateWrangler: NpmIdentity;
  /**
   * (METHOD normalized-path) routes implemented by the candidate official
   * SDK, extracted statically from its published resources.
   */
  candidateSdkRoutes: Map<string, string[]>;
  /** Selection manifest used to build the candidate subset. */
  manifest: unknown;
  /** Selected-operation keys the manifest excludes from the SDK surface. */
  sdkExcludedOperations: string[];
  /** Operations exported by the committed baseline SDK surface. */
  baselineMappedOperations: string[];
  /** Operation digests from the committed baseline subset inventory. */
  baselineInventory: Array<{ id: string; operationSha256: string }>;
  /** Operation keys the baseline manifest selected. */
  selectedOperations: string[];
}

export function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(path: string): string {
  return path.replaceAll(/\{[^}]*\}/g, "{}");
}

export function classify(input: ScanInput): UpstreamReport {
  const reasons: string[] = [];
  const waitingOn: string[] = [];
  const candidateSchema = JSON.parse(
    input.candidateSchema.bytes.toString("utf8"),
  );
  const candidatePaths = (candidateSchema.paths ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const baselineMapped = new Set(input.baselineMappedOperations);
  const lostOperations: string[] = [];
  const removedOperations = input.selectedOperations.filter((id) => {
    const separator = id.indexOf(" ");
    const method = id.slice(0, separator).toLowerCase();
    const path = id.slice(separator + 1);
    return candidatePaths[path]?.[method] === undefined;
  });
  const changedOperations: string[] = [];
  if (removedOperations.length === 0) {
    const candidate = buildSubset(
      candidateSchema,
      input.manifest,
      input.candidateSchema.revision,
      sha256Hex(input.candidateSchema.bytes),
    );
    const candidateDigests = new Map(
      (
        candidate["x-open-compute-operation-inventory"] as Array<{
          id: string;
          operationSha256: string;
        }>
      ).map((entry) => [entry.id, entry.operationSha256]),
    );
    const baselineDigests = new Map(
      input.baselineInventory.map((entry) => [entry.id, entry.operationSha256]),
    );
    for (const id of input.selectedOperations) {
      const digest = candidateDigests.get(id);
      if (digest === undefined) continue;
      if (baselineDigests.get(id) !== digest) changedOperations.push(id);
    }
    for (const entry of candidate[
      "x-open-compute-operation-inventory"
    ] as Array<{
      id: string;
      method: string;
      path: string;
      status: string;
    }>) {
      if (
        entry.status !== "supported" &&
        entry.status !== "supported_with_deviation"
      )
        continue;
      if (input.sdkExcludedOperations.includes(entry.id)) continue;
      const route = `${entry.method} ${normalize(entry.path)}`;
      if (!input.candidateSdkRoutes.has(route)) lostOperations.push(entry.id);
    }
    lostOperations.sort();
  }
  changedOperations.sort();
  const unmappedOperations = [...lostOperations];

  const schemaChanged =
    input.candidateSchema.revision !== input.baseline.openapiRevision ||
    changedOperations.length > 0 ||
    removedOperations.length > 0;
  const sdkChanged =
    input.candidateCloudflare.version !== input.baseline.cloudflareSdkVersion;
  const wranglerChanged =
    input.candidateWrangler.version !== input.baseline.wranglerVersion;
  const routesMoved =
    removedOperations.length > 0 || changedOperations.length > 0;

  let classification: Classification;
  if (
    !schemaChanged &&
    !sdkChanged &&
    !wranglerChanged &&
    unmappedOperations.length === 0
  ) {
    classification = "unchanged";
  } else if (removedOperations.length > 0) {
    reasons.push(
      `selected operations disappeared from the upstream snapshot: ${removedOperations.join(", ")}`,
    );
    classification = "breaking";
  } else if (lostOperations.length > 0) {
    // Operations exported by the current surface vanished from the candidate
    // official SDK closure.
    reasons.push(
      `the candidate official SDK no longer implements mapped operations: ${lostOperations.join(", ")}`,
    );
    classification = "breaking";
  } else {
    if (unmappedOperations.length > 0) {
      reasons.push(
        "manifest-excluded operations remain unimplemented by the candidate official SDK; the exclusion stays authoritative",
      );
    }
    if (wranglerChanged) {
      reasons.push(
        "wrangler pin move requires coordinated config/CLI evidence and product Gate regeneration beyond the mechanical candidate PR",
      );
      waitingOn.push("this repository's wrangler evidence implementation");
      classification = "blocked";
    } else if (schemaChanged && !sdkChanged && routesMoved) {
      reasons.push(
        "schema snapshot moved but the published official SDK did not; changed operations are not proven against a newer published SDK",
      );
      waitingOn.push("official cloudflare SDK stable release");
      classification = "blocked";
    } else {
      if (schemaChanged) {
        reasons.push(
          `schema snapshot revision ${input.candidateSchema.revision} re-selects ${changedOperations.length} changed operations`,
        );
      }
      if (sdkChanged) {
        reasons.push(
          `official SDK candidate ${input.candidateCloudflare.version} implements the selected contract closure`,
        );
      }
      classification = "ready";
    }
  }

  return {
    schemaVersion: 1,
    classification,
    generatedAtUtc: new Date().toISOString(),
    baseline: {
      openapiRevision: input.baseline.openapiRevision,
      openapiSha256: input.baseline.openapiSha256,
      cloudflareSdkVersion: input.baseline.cloudflareSdkVersion,
      wranglerVersion: input.baseline.wranglerVersion,
    },
    candidate: {
      openapiRevision: input.candidateSchema.revision,
      openapiSha256: sha256Hex(input.candidateSchema.bytes),
      cloudflareSdk: input.candidateCloudflare,
      wrangler: input.candidateWrangler,
    },
    selectedOperations: input.selectedOperations.length,
    changedOperations,
    removedOperations,
    unmappedOperations,
    waitingOn,
    reasons,
  };
}

interface LockBaseline {
  revision: string;
  sha256: string;
  cloudflareSdk: { version: string };
  wrangler: { version: string };
}

function loadBaseline(): LockBaseline {
  return JSON.parse(readFileSync(LOCK_PATH, "utf8")) as LockBaseline;
}

function loadManifestSelections(): {
  selected: string[];
  excluded: string[];
} {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    operations: string[];
    deferredOperations: Array<{ operation: string }>;
    unsupportedOperations: Array<{ operation: string }>;
    sdkExcludedOperations: Array<{ operation: string }>;
  };
  const subset = JSON.parse(readFileSync(SUBSET_PATH, "utf8")) as {
    "x-open-compute-operation-inventory": Array<{
      id: string;
      operationSha256: string;
    }>;
  };
  return {
    selected: [
      ...manifest.operations,
      ...manifest.deferredOperations.map((entry) => entry.operation),
      ...manifest.unsupportedOperations.map((entry) => entry.operation),
    ],
    excluded: manifest.sdkExcludedOperations.map((entry) => entry.operation),
  };
}

async function npmIdentity(name: string): Promise<NpmIdentity> {
  const response = await fetch(`https://registry.npmjs.org/${name}/latest`);
  if (!response.ok)
    throw new Error(
      `npm registry lookup for ${name} failed: ${response.status}`,
    );
  const metadata = (await response.json()) as {
    version: string;
    dist: { shasum: string; integrity: string };
  };
  return {
    version: metadata.version,
    npmShasum: metadata.dist.shasum,
    npmIntegrity: metadata.dist.integrity,
  };
}

function headRevision(): string {
  const result = spawnSync(
    "git",
    ["ls-remote", "https://github.com/cloudflare/api-schemas", "HEAD"],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || !result.stdout)
    throw new Error("cannot resolve the api-schemas HEAD revision");
  return result.stdout.trim().split(/\s+/)[0] ?? "";
}

async function downloadSchema(revision: string): Promise<Buffer> {
  const response = await fetch(
    `https://raw.githubusercontent.com/cloudflare/api-schemas/${revision}/openapi.json`,
  );
  if (!response.ok)
    throw new Error(`api-schemas snapshot download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function candidateSdkRoutesFor(
  name: string,
  identity: NpmIdentity,
  target: string,
): Promise<Map<string, string[]>> {
  const baseline = loadBaseline();
  const baselineVersion =
    name === "cloudflare"
      ? baseline.cloudflareSdk.version
      : baseline.wrangler.version;
  if (identity.version === baselineVersion) {
    return candidateSdkRoutesForInstalled();
  }
  const tarballResponse = await fetch(
    `https://registry.npmjs.org/${name}/-/${name}-${identity.version}.tgz`,
  );
  if (!tarballResponse.ok)
    throw new Error(
      `${name} tarball download failed: ${tarballResponse.status}`,
    );
  const tarball = Buffer.from(await tarballResponse.arrayBuffer());
  const shasum = createHash("sha1").update(tarball).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  if (shasum !== identity.npmShasum || integrity !== identity.npmIntegrity)
    throw new Error(
      `${name} candidate tarball does not match registry identity`,
    );
  const extractRoot = join(REVIEW_ROOT, target);
  rmSync(extractRoot, { recursive: true, force: true });
  mkdirSync(extractRoot, { recursive: true });
  const tarballPath = join(extractRoot, "package.tgz");
  writeFileSync(tarballPath, tarball);
  const extract = spawnSync("tar", ["-xzf", tarballPath, "-C", extractRoot], {
    encoding: "utf8",
  });
  if (extract.status !== 0)
    throw new Error(`${name} tarball extraction failed: ${extract.stderr}`);
  const scan = await scanOfficialPackage(join(extractRoot, "package"));
  const routes = new Map<string, string[]>();
  for (const method of scan.methods.values()) {
    const route = `${method.httpMethod} ${method.pathTemplate}`;
    routes.set(route, [
      ...(routes.get(route) ?? []),
      `${method.module}::${method.className}::${method.method}`,
    ]);
  }
  return routes;
}

async function candidateSdkRoutesForInstalled(): Promise<
  Map<string, string[]>
> {
  const scan = await scanOfficialPackage(
    resolve(REPO_ROOT, "packages/sdk/node_modules/cloudflare"),
  );
  const routes = new Map<string, string[]>();
  for (const method of scan.methods.values()) {
    const route = `${method.httpMethod} ${method.pathTemplate}`;
    routes.set(route, [
      ...(routes.get(route) ?? []),
      `${method.module}::${method.className}::${method.method}`,
    ]);
  }
  return routes;
}

function summarize(report: UpstreamReport): string {
  const lines = [
    `classification: ${report.classification}`,
    `baseline openapi ${report.baseline.openapiRevision.slice(0, 12)} sdk ${report.baseline.cloudflareSdkVersion} wrangler ${report.baseline.wranglerVersion}`,
    `candidate openapi ${report.candidate.openapiRevision?.slice(0, 12) ?? "-"} sdk ${report.candidate.cloudflareSdk?.version ?? "-"} wrangler ${report.candidate.wrangler?.version ?? "-"}`,
    `selected operations: ${report.selectedOperations}`,
    `changed operations (${report.changedOperations.length}): ${report.changedOperations.slice(0, 20).join(", ")}`,
    `removed operations (${report.removedOperations.length})`,
    `unmapped operations (${report.unmappedOperations.length})`,
    ...report.reasons.map((reason) => `reason: ${reason}`),
    ...report.waitingOn.map((owner) => `waiting on: ${owner}`),
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  mkdirSync(REVIEW_ROOT, { recursive: true });
  const baseline = loadBaseline();
  const selections = loadManifestSelections();
  const subset = JSON.parse(readFileSync(SUBSET_PATH, "utf8")) as {
    "x-open-compute-operation-inventory": Array<{
      id: string;
      operationSha256: string;
    }>;
  };
  const revision = headRevision();
  const candidateSchemaBytes = await downloadSchema(revision);
  const [cloudflare, wrangler] = await Promise.all([
    npmIdentity("cloudflare"),
    npmIdentity("wrangler"),
  ]);
  const sdkRoutes = await candidateSdkRoutesFor(
    "cloudflare",
    cloudflare,
    "candidate-sdk",
  );
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const surface = JSON.parse(
    readFileSync(join(REPO_ROOT, "packages/sdk/surface.json"), "utf8"),
  ) as { operations: Array<{ operation: string }> };
  const report = classify({
    baseline: {
      openapiRevision: baseline.revision,
      openapiSha256: baseline.sha256,
      cloudflareSdkVersion: baseline.cloudflareSdk.version,
      wranglerVersion: baseline.wrangler.version,
    },
    candidateSchema: { revision, bytes: candidateSchemaBytes },
    candidateCloudflare: cloudflare,
    candidateWrangler: wrangler,
    candidateSdkRoutes: sdkRoutes,
    manifest,
    sdkExcludedOperations: selections.excluded,
    baselineMappedOperations: surface.operations.map(
      (operation) => operation.operation,
    ),
    baselineInventory: subset["x-open-compute-operation-inventory"],
    selectedOperations: selections.selected,
  });
  writeFileSync(
    join(REVIEW_ROOT, "upstream-review.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const summary = summarize(report);
  writeFileSync(join(REVIEW_ROOT, "summary.txt"), `${summary}\n`);
  console.log(summary);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();

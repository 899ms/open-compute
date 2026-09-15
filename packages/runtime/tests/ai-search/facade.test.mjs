import assert from "node:assert/strict";
import test from "node:test";
import {
  compileRuntime,
  importRuntime,
  moduleUrl,
} from "../compiled-runtime.mjs";

const validation = moduleUrl(await compileRuntime("ai-search/validation.ts"));
const responses = moduleUrl(
  await compileRuntime("ai-search/responses.ts", {
    "./validation.js": validation,
  }),
);
const { AiSearchNamespaceBinding, AiSearchInstanceBinding } =
  await importRuntime("ai-search/facade.ts", {
    "./responses.js": responses,
    "./validation.js": validation,
  });
const instance = { id: "docs", status: "ready" };
const manualSource = {
  provider_id: "files",
  source: "primary",
  key: "guide.txt",
  revision: "rev-1",
};
const item = {
  id: "item-1",
  key: "guide.txt",
  status: "completed",
  open_compute_source: manualSource,
};
const job = { id: "job-1", source: "user" };

function transport(calls) {
  return {
    async call(operation, selected, payload) {
      calls.push({ operation, selected, payload });
      if (operation === "namespace.list")
        return {
          result: [instance],
          result_info: { count: 1, page: 1, per_page: 10, total_count: 1 },
        };
      if (
        operation === "namespace.create" ||
        operation === "namespace.openComputeCreateManual" ||
        operation === "items.openComputeUpsert" ||
        operation.endsWith(".info") ||
        operation === "instance.update"
      )
        return operation.startsWith("item.") ||
          operation === "items.openComputeUpsert"
          ? item
          : operation.startsWith("job.")
            ? job
            : instance;
      if (operation.endsWith(".search"))
        return {
          search_query: "cache",
          chunks: [
            {
              id: "018ff000-0000-8000-8000-000000000002",
              ...(operation === "namespace.search"
                ? { instance_id: "docs" }
                : {}),
              type: "keyword",
              score: 1,
              text: "cache",
              item: {
                key: "guide.txt",
                open_compute_source: manualSource,
              },
            },
          ],
        };
      if (operation.endsWith(".chatCompletions"))
        return {
          choices: [{ message: { role: "assistant", content: "answer" } }],
          chunks: [],
        };
      if (operation === "instance.stats") return { completed: 1 };
      if (operation === "items.list")
        return {
          result: [item],
          result_info: { count: 1, page: 1, per_page: 10, total_count: 1 },
        };
      if (operation === "items.delete") return { key: "guide.txt" };
      if (operation === "namespace.delete") return null;
      if (operation === "item.logs")
        return {
          result: [],
          result_info: {
            count: 0,
            per_page: 50,
            cursor: null,
            truncated: false,
          },
        };
      if (operation === "item.chunks")
        return {
          result: [],
          result_info: { count: 0, total: 0, limit: 20, offset: 0 },
        };
      if (operation === "jobs.list")
        return {
          result: [job],
          result_info: { count: 1, page: 1, per_page: 10, total_count: 1 },
        };
      if (operation === "jobs.create" || operation === "job.cancel") return job;
      if (operation === "job.logs")
        return {
          result: [],
          result_info: { count: 0, page: 1, per_page: 10, total_count: 0 },
        };
      throw new Error(`unexpected ${operation}`);
    },
    async stream() {
      return new Response("data: ok\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    async upload(_selected, _name, contentType, _body, options) {
      calls.push({ operation: "upload", contentType, options });
      return item;
    },
    async download() {
      return new Response("guide", {
        headers: {
          "content-type": "text/plain",
          "content-length": "5",
          "x-open-compute-filename": "guide.txt",
          "x-open-compute-source-provider": "files",
          "x-open-compute-source": "primary",
          "x-open-compute-revision": "rev-1",
        },
      });
    },
  };
}

test("AI Search namespace, instance, item, job, upload, download, and stream surfaces are reachable", async () => {
  const calls = [];
  const raw = transport(calls);
  const namespace = new AiSearchNamespaceBinding(raw);
  assert.equal(namespace.get("docs") instanceof AiSearchInstanceBinding, true);
  assert.equal(
    (
      await namespace.list({
        order_by: "created_at",
        order_by_direction: "asc",
      })
    ).result[0].id,
    "docs",
  );
  assert.equal(
    (await namespace.create({ id: "new-docs", index_method: { vector: true } }))
      .constructor,
    AiSearchInstanceBinding,
  );
  assert.equal(
    (
      await namespace.openComputeCreateManual("files", {
        id: "manual-docs",
        index_method: { keyword: true },
      })
    ).constructor,
    AiSearchInstanceBinding,
  );
  const token = "018ff000-0000-8000-8000-000000000001";
  await namespace.create({
    id: "a".repeat(64),
    type: "r2",
    source: "documents",
    source_params: {
      prefix: "",
      include_items: ["**/*.pdf"],
      exclude_items: ["**/*.tmp"],
    },
    token_id: token,
    sync_interval: 900,
    paused: true,
  });
  assert.equal(
    calls.find(
      (call) =>
        call.operation === "namespace.create" && call.payload.type === "r2",
    ).payload.source,
    "documents",
  );
  assert.equal(
    (
      await namespace.search({
        query: "cache",
        ai_search_options: { instance_ids: ["docs"] },
      })
    ).search_query,
    "cache",
  );
  assert.ok(
    (await namespace.chatCompletions({
      messages: [{ role: "user", content: "cache" }],
      stream: true,
      ai_search_options: { instance_ids: ["docs"] },
    })) instanceof ReadableStream,
  );
  const direct = new AiSearchInstanceBinding(raw);
  assert.equal(
    (await direct.search({ query: "cache" })).chunks[0].item.open_compute_source
      .revision,
    "rev-1",
  );
  assert.equal((await direct.info()).id, "docs");
  assert.equal((await direct.update({ paused: true })).id, "docs");
  assert.equal((await direct.stats()).completed, 1);
  assert.equal((await direct.items.list()).result[0].id, "item-1");
  assert.equal(
    (
      await direct.items.openComputeUpsert({
        key: "files/guide.txt",
        revision: "rev-1",
        contentType: "text/plain",
      })
    ).id,
    "item-1",
  );
  assert.equal(
    (
      await direct.items.upload("guide.txt", "guide", {
        metadata: { rank: "2" },
      })
    ).id,
    "item-1",
  );
  const download = await direct.items.get("item-1").download();
  assert.equal(download.filename, "guide.txt");
  assert.equal(download.open_compute_source.revision, "rev-1");
  assert.equal((await direct.items.get("item-1").logs()).result.length, 0);
  assert.equal((await direct.items.get("item-1").chunks()).result.length, 0);
  await direct.items.delete("item-1");
  assert.equal((await direct.jobs.list()).result[0].id, "job-1");
  assert.equal(
    (await direct.jobs.create({ description: "refresh" })).id,
    "job-1",
  );
  assert.equal((await direct.jobs.get("job-1").cancel()).id, "job-1");
  assert.equal(
    calls.find((call) => call.operation === "upload").contentType,
    "text/plain",
  );
  assert.deepEqual(calls.find((call) => call.operation === "upload").options, {
    metadata: { rank: "2" },
  });
  assert.deepEqual(
    calls.find((call) => call.operation === "items.openComputeUpsert").payload,
    {
      key: "files/guide.txt",
      revision: "rev-1",
      contentType: "text/plain",
      metadata: {},
      waitForCompletion: false,
    },
  );
});

test("AI Search rejects unknown options, limits, unsupported first tranche, and malformed backend success", async () => {
  const raw = transport([]);
  const direct = new AiSearchInstanceBinding(raw);
  await assert.rejects(
    direct.search({ query: "x", extra: true }),
    /AI_SEARCH_INPUT_INVALID/,
  );
  await assert.rejects(
    direct.search({
      query: "x",
      ai_search_options: { retrieval: { max_num_results: 51 } },
    }),
    /AI_SEARCH_INPUT_INVALID/,
  );
  await assert.rejects(
    direct.search({
      query: "x",
      ai_search_options: { retrieval: { boost_by: [{ field: "x" }] } },
    }),
    /AI_SEARCH_OPTION_UNSUPPORTED/,
  );
  await assert.rejects(
    direct.update({ chunk_overlap: 31 }),
    /AI_SEARCH_INPUT_INVALID/,
  );
  await assert.rejects(
    new AiSearchNamespaceBinding(raw).create({
      id: "bad-r2",
      type: "r2",
      source: "documents",
      source_params: { include_items: ["[invalid]"] },
    }),
    /AI_SEARCH_INPUT_INVALID/,
  );
  assert.equal(
    (await direct.update({ embedding_model: "@cf/baai/bge-large-en-v1.5" })).id,
    "docs",
  );
  await assert.rejects(
    direct.items.upload("guide.txt", "guide", { metadata: { rank: 2 } }),
    /AI_SEARCH_INPUT_INVALID/,
  );
  const malformed = new AiSearchInstanceBinding({
    ...raw,
    async call() {
      return { choices: [] };
    },
  });
  await assert.rejects(
    malformed.search({ query: "x" }),
    /AI_SEARCH_INPUT_INVALID|AI_SEARCH_PROTOCOL_ERROR/,
  );
  const badStream = new AiSearchInstanceBinding({
    ...raw,
    async stream() {
      return new Response("x");
    },
  });
  await assert.rejects(
    badStream.chatCompletions({
      messages: [{ role: "user", content: "x" }],
      stream: true,
    }),
    /AI_SEARCH_PROTOCOL_ERROR/,
  );
});

import { createOpenComputeClient } from "../../src/index.ts";

const client = createOpenComputeClient({
  apiToken: "token",
  baseURL: "http://127.0.0.1:18787/client/v4",
});

await client.aiGateway.list({});

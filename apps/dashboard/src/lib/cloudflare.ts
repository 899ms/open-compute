import { createOpenComputeClient } from "@open-compute/sdk";

/** Create the browser management client over the capability-scoped SDK. */
export function createManagementClient(token: string) {
  return createOpenComputeClient({
    apiToken: token,
    baseURL: new URL("/client/v4", window.location.origin).href,
    maxRetries: 0,
  });
}

export type ManagementClient = ReturnType<typeof createManagementClient>;

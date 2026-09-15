import { BaseCloudflare, type ClientOptions } from "cloudflare/client";
import { buildFacade, type OpenComputeSurface } from "./generated.ts";

/**
 * Construction options for the capability-scoped open-compute management
 * client. Timeout, retry, fetch, query, and logger fields reuse the official
 * transport contract; authentication and the target deployment are stricter.
 */
export type OpenComputeClientOptions = Omit<
  ClientOptions,
  | "apiToken"
  | "apiKey"
  | "apiEmail"
  | "userServiceKey"
  | "baseURL"
  | "apiVersion"
  | "defaultHeaders"
> & {
  /** A deployer- or admin-scoped open-compute API token. Required. */
  apiToken: string;
  /**
   * Absolute base URL of the open-compute management API. The canonical path
   * must end in `/client/v4`; plain HTTP is only accepted for loopback hosts.
   */
  baseURL: string;
  /**
   * Default headers for every request. Authorization and platform-internal
   * headers cannot be overridden here or per request.
   */
  defaultHeaders?: ClientOptions["defaultHeaders"];
};

const FORBIDDEN_HEADER_PREFIXES = ["x-open-compute-"];

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replaceAll(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

function validateApiToken(apiToken: string): string {
  if (apiToken.length === 0 || apiToken.trim().length === 0)
    throw new Error("apiToken must be a non-empty open-compute API token");
  if (/[\u0000-\u001F\u007F]/.test(apiToken))
    throw new Error("apiToken must not contain control characters");
  return apiToken;
}

function validateBaseURL(baseURL: string): string {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new Error("baseURL must be an absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("baseURL must use https or loopback http");
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname))
    throw new Error(
      "baseURL may only use plain http for loopback test addresses",
    );
  if (url.username !== "" || url.password !== "")
    throw new Error("baseURL must not contain user info");
  if (url.search !== "" || url.hash !== "")
    throw new Error("baseURL must not contain a query or fragment");
  const canonical = url.pathname.replace(/\/$/, "");
  if (!canonical.endsWith("/client/v4"))
    throw new Error('baseURL canonical path must end in "/client/v4"');
  return baseURL;
}

function validateDefaultHeaders(
  defaultHeaders: ClientOptions["defaultHeaders"],
): ClientOptions["defaultHeaders"] {
  if (defaultHeaders === null || defaultHeaders === undefined)
    return defaultHeaders;
  const entries =
    defaultHeaders instanceof Headers
      ? [...defaultHeaders.entries()]
      : Object.entries(defaultHeaders as Record<string, unknown>);
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (lower === "authorization")
      throw new Error(
        "defaultHeaders may not override Authorization; use apiToken",
      );
    if (FORBIDDEN_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix)))
      throw new Error(
        `defaultHeaders may not override platform-internal header ${name}`,
      );
    if (typeof value !== "string" && value !== null && value !== undefined)
      throw new Error(`defaultHeaders value for ${name} must be a string`);
  }
  return defaultHeaders;
}

/**
 * Create the capability-scoped open-compute management client. Construction
 * never touches the network and never falls back to ambient credentials; the
 * returned surface exposes only the qualified operations of the pinned
 * authority plus the `openCompute` vendor namespace.
 */
export function createOpenComputeClient(
  options: OpenComputeClientOptions,
): OpenComputeSurface {
  const transport = new BaseCloudflare({
    ...options,
    apiToken: validateApiToken(options.apiToken),
    baseURL: validateBaseURL(options.baseURL),
    ...(options.defaultHeaders === undefined
      ? {}
      : { defaultHeaders: validateDefaultHeaders(options.defaultHeaders) }),
  });
  return buildFacade(transport);
}

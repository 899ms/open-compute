import type { APIPromise, Cloudflare } from "cloudflare";
import type { BaseCloudflare } from "cloudflare/client";
import {
  CursorLimitPagination,
  V4PagePaginationArray,
  type PagePromise,
} from "cloudflare/core/pagination";

type Options = Cloudflare.RequestOptions;
type Envelope<T> = { readonly result: T };

export interface ArtifactNamespace {
  readonly namespace: string;
  readonly repo_count: number;
  readonly jurisdiction?: "eu" | "us";
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ArtifactRepository {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly default_branch: string;
  readonly remote: string;
  readonly read_only: boolean;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_push_at?: string;
  readonly source?: string;
}

export interface CreatedArtifactRepository extends Pick<
  ArtifactRepository,
  "id" | "name" | "description" | "default_branch" | "remote"
> {
  readonly token: string;
}

export interface ArtifactToken {
  readonly id: string;
  readonly scope: "read" | "write";
  readonly expires_at: string;
  readonly state?: "active" | "expired" | "revoked";
  readonly created_at?: string;
  readonly plaintext?: string;
}

export interface ArtifactObject {
  readonly id: string;
  readonly type: "commit" | "tree";
  readonly content: string;
}

export interface ArtifactCommit {
  readonly id: string;
  readonly content: string;
}

export interface ArtifactListParams {
  readonly account_id: string;
  readonly limit?: number;
  readonly cursor?: string;
}

function segment(value: string): string {
  if (value.length === 0 || value === "." || value === "..")
    throw new Error("invalid Artifacts path segment");
  return encodeURIComponent(value);
}

function rawPath(value: string): string {
  return value.split("/").map(segment).join("/");
}

function query<T extends { readonly account_id: string }>(
  params: T,
): Omit<T, "account_id"> {
  const { account_id: _accountID, ...value } = params;
  return value;
}

function unwrap<T>(promise: APIPromise<Envelope<T>>): APIPromise<T> {
  return promise._thenUnwrap((envelope) => envelope.result);
}

/** First-party delegate for Cloudflare's observed Artifacts REST contract. */
export class Artifacts {
  readonly namespaces;
  readonly repositories;
  readonly tokens;

  constructor(transport: BaseCloudflare) {
    const base = (account: string) =>
      `/accounts/${segment(account)}/artifacts/namespaces`;
    const repository = (account: string, namespace: string, name: string) =>
      `${base(account)}/${segment(namespace)}/repos/${segment(name)}`;

    this.namespaces = {
      create: (
        params: {
          readonly account_id: string;
          readonly namespace: string;
          readonly jurisdiction?: "eu" | "us";
        },
        options?: Options,
      ): APIPromise<ArtifactNamespace> =>
        unwrap(
          transport.post(`${base(params.account_id)}`, {
            ...options,
            body: {
              namespace: params.namespace,
              jurisdiction: params.jurisdiction,
            },
          }),
        ),
      list: (
        params: ArtifactListParams,
        options?: Options,
      ): PagePromise<CursorLimitPagination<ArtifactNamespace>> =>
        transport.getAPIList(
          base(params.account_id),
          CursorLimitPagination<ArtifactNamespace>,
          { ...options, query: query(params) },
        ),
      get: (
        namespace: string,
        params: { readonly account_id: string },
        options?: Options,
      ): APIPromise<ArtifactNamespace> =>
        unwrap(
          transport.get(
            `${base(params.account_id)}/${segment(namespace)}`,
            options,
          ),
        ),
    };

    this.repositories = {
      create: (
        namespace: string,
        params: {
          readonly account_id: string;
          readonly name: string;
          readonly description?: string;
          readonly default_branch?: string;
          readonly read_only?: boolean;
        },
        options?: Options,
      ): APIPromise<CreatedArtifactRepository> =>
        unwrap(
          transport.post(
            `${base(params.account_id)}/${segment(namespace)}/repos`,
            {
              ...options,
              body: {
                name: params.name,
                description: params.description,
                default_branch: params.default_branch,
                read_only: params.read_only,
              },
            },
          ),
        ),
      list: (
        namespace: string,
        params: ArtifactListParams & {
          readonly search?: string;
          readonly sort?: "name" | "created_at" | "updated_at" | "last_push_at";
          readonly direction?: "asc" | "desc";
        },
        options?: Options,
      ): PagePromise<CursorLimitPagination<ArtifactRepository>> =>
        transport.getAPIList(
          `${base(params.account_id)}/${segment(namespace)}/repos`,
          CursorLimitPagination<ArtifactRepository>,
          { ...options, query: query(params) },
        ),
      get: (
        namespace: string,
        name: string,
        params: { readonly account_id: string },
        options?: Options,
      ): APIPromise<ArtifactRepository> =>
        unwrap(
          transport.get(
            repository(params.account_id, namespace, name),
            options,
          ),
        ),
      delete: (
        namespace: string,
        name: string,
        params: { readonly account_id: string },
        options?: Options,
      ): APIPromise<{ readonly id: string }> =>
        unwrap(
          transport.delete(
            repository(params.account_id, namespace, name),
            options,
          ),
        ),
      fork: (
        namespace: string,
        name: string,
        params: {
          readonly account_id: string;
          readonly body: {
            readonly name: string;
            readonly description?: string;
            readonly read_only?: boolean;
            readonly default_branch_only?: boolean;
          };
        },
        options?: Options,
      ): APIPromise<CreatedArtifactRepository & { readonly objects: number }> =>
        unwrap(
          transport.post(
            `${repository(params.account_id, namespace, name)}/fork`,
            {
              ...options,
              body: params.body,
            },
          ),
        ),
      import: (
        namespace: string,
        name: string,
        params: {
          readonly account_id: string;
          readonly body: {
            readonly url: string;
            readonly branch?: string;
            readonly depth?: number;
            readonly read_only?: boolean;
          };
        },
        options?: Options,
      ): APIPromise<CreatedArtifactRepository> =>
        unwrap(
          transport.post(
            `${repository(params.account_id, namespace, name)}/import`,
            {
              ...options,
              body: params.body,
            },
          ),
        ),
      log: (
        namespace: string,
        name: string,
        params: {
          readonly account_id: string;
          readonly ref?: string;
          readonly limit?: number;
          readonly offset?: number;
        },
        options?: Options,
      ): APIPromise<readonly ArtifactCommit[]> =>
        unwrap(
          transport.get(
            `${repository(params.account_id, namespace, name)}/log`,
            {
              ...options,
              query: query(params),
            },
          ),
        ),
      commit: (
        namespace: string,
        name: string,
        oid: string,
        params: { readonly account_id: string },
        options?: Options,
      ): APIPromise<ArtifactObject> =>
        unwrap(
          transport.get(
            `${repository(params.account_id, namespace, name)}/commit/${segment(oid)}`,
            options,
          ),
        ),
      tree: (
        namespace: string,
        name: string,
        oid: string,
        params: { readonly account_id: string },
        options?: Options,
      ): APIPromise<ArtifactObject> =>
        unwrap(
          transport.get(
            `${repository(params.account_id, namespace, name)}/tree/${segment(oid)}`,
            options,
          ),
        ),
      blob: (
        namespace: string,
        name: string,
        oid: string,
        params: { readonly account_id: string },
        options?: Options,
      ): APIPromise<Response> =>
        transport.get(
          `${repository(params.account_id, namespace, name)}/blob/${segment(oid)}`,
          { ...options, __binaryResponse: true },
        ),
      file: (
        namespace: string,
        name: string,
        params: {
          readonly account_id: string;
          readonly ref: string;
          readonly path: string;
        },
        options?: Options,
      ): APIPromise<Response> =>
        transport.get(
          `${repository(params.account_id, namespace, name)}/file`,
          { ...options, query: query(params), __binaryResponse: true },
        ),
      raw: (
        namespace: string,
        name: string,
        reference: string,
        path: string,
        params: { readonly account_id: string },
        options?: Options,
      ): APIPromise<Response> =>
        transport.get(
          `${repository(params.account_id, namespace, name)}/raw/${segment(reference)}/${rawPath(path)}`,
          { ...options, __binaryResponse: true },
        ),
    };

    this.tokens = {
      issue: (
        namespace: string,
        params: {
          readonly account_id: string;
          readonly repo: string;
          readonly scope?: "read" | "write";
          readonly ttl?: number;
        },
        options?: Options,
      ): APIPromise<ArtifactToken> =>
        unwrap(
          transport.post(
            `${base(params.account_id)}/${segment(namespace)}/tokens`,
            {
              ...options,
              body: { repo: params.repo, scope: params.scope, ttl: params.ttl },
            },
          ),
        ),
      list: (
        namespace: string,
        name: string,
        params: {
          readonly account_id: string;
          readonly state?: "active" | "expired" | "revoked" | "all";
          readonly per_page?: number;
          readonly page?: number;
        },
        options?: Options,
      ): PagePromise<V4PagePaginationArray<ArtifactToken>> =>
        transport.getAPIList(
          `${repository(params.account_id, namespace, name)}/tokens`,
          V4PagePaginationArray<ArtifactToken>,
          { ...options, query: query(params) },
        ),
      revoke: (
        namespace: string,
        token: string,
        params: { readonly account_id: string },
        options?: Options,
      ): APIPromise<{ readonly id: string }> =>
        unwrap(
          transport.delete(
            `${base(params.account_id)}/${segment(namespace)}/tokens/${segment(token)}`,
            options,
          ),
        ),
    };
  }
}

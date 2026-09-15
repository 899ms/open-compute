/// <reference types="@cloudflare/workers-types" />

declare module "open-compute:ai" {
  /** Workers AI binding surface currently implemented by open-compute. */
  export type OpenComputeAi = Pick<Ai, "aiGatewayLogId" | "toMarkdown">;
}

declare module "open-compute:cache" {
  export interface CachePurgeOptions {
    tags?: string[];
    pathPrefixes?: string[];
    purgeEverything?: boolean;
  }

  export interface CachePurgeResult {
    readonly success: boolean;
    readonly deleted: number;
  }

  export interface ExecutionContextCache {
    purge(options?: CachePurgeOptions): Promise<CachePurgeResult>;
  }
}

declare module "open-compute:ai-search" {
  export interface OpenComputeManualUpsertInput {
    key: string;
    revision: string;
    contentType: string;
    metadata?: Record<string, string>;
    waitForCompletion?: boolean;
  }

  export interface OpenComputeManualSource {
    readonly provider_id: string;
    readonly source: string;
    readonly key: string;
    readonly revision: string;
  }

  export type OpenComputeAiSearchItemInfo = AiSearchItemInfo & {
    readonly open_compute_source?: OpenComputeManualSource;
  };

  export type OpenComputeAiSearchSearchResponse = AiSearchSearchResponse & {
    readonly chunks: Array<
      AiSearchSearchResponse["chunks"][number] & {
        readonly item: AiSearchSearchResponse["chunks"][number]["item"] & {
          readonly open_compute_source?: OpenComputeManualSource;
        };
      }
    >;
  };

  export type OpenComputeAiSearchItemContentResult =
    AiSearchItemContentResult & {
      readonly open_compute_source?: OpenComputeManualSource;
    };

  export interface OpenComputeAiSearchItem extends Omit<
    AiSearchItem,
    "download" | "info" | "sync"
  > {
    download(): Promise<OpenComputeAiSearchItemContentResult>;
    info(): Promise<OpenComputeAiSearchItemInfo>;
    sync(): Promise<OpenComputeAiSearchItemInfo>;
  }

  export interface OpenComputeAiSearchItems extends Omit<
    AiSearchItems,
    "get" | "list"
  > {
    get(itemId: string): OpenComputeAiSearchItem;
    list(params?: AiSearchListItemsParams): Promise<
      Omit<AiSearchListItemsResponse, "result"> & {
        result: OpenComputeAiSearchItemInfo[];
      }
    >;
    openComputeUpsert(
      input: OpenComputeManualUpsertInput,
    ): Promise<OpenComputeAiSearchItemInfo>;
  }

  export interface OpenComputeAiSearchInstance extends Omit<
    AiSearchInstance,
    "items" | "search"
  > {
    readonly items: OpenComputeAiSearchItems;
    search(
      ...args: Parameters<AiSearchInstance["search"]>
    ): Promise<OpenComputeAiSearchSearchResponse>;
  }

  export interface OpenComputeAiSearchNamespace extends Omit<
    AiSearchNamespace,
    "get" | "create"
  > {
    get(name: string): OpenComputeAiSearchInstance;
    create(config: AiSearchConfig): Promise<OpenComputeAiSearchInstance>;
    openComputeCreateManual(
      providerId: string,
      config: AiSearchConfig,
    ): Promise<OpenComputeAiSearchInstance>;
  }
}

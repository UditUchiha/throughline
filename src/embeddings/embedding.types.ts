export interface EmbeddingProvider {
  /**
   * `signal` lets a caller's deadline reach the network call. Without it an
   * agent run's wall-clock budget cannot bound retrieval, only the model calls
   * around it.
   */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  readonly dimensions: number;
  readonly modelId: string;
}

export const EMBEDDING_SERVICE = Symbol('EMBEDDING_SERVICE');

/**
 * How a provider names the model it embeds with. Qualified by provider because
 * the same model name served by two hosts is not guaranteed to produce the same
 * vectors, and an index is only reusable if both halves match.
 */
export function embeddingModelId(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/**
 * The string stored in `index_meta` and compared at boot.
 *
 * It lives here, in one function, because the writer (IndexingService, after a
 * reindex) and the reader (the boot-time check in DatabaseModule) reach it from
 * opposite directions. When they each built the string themselves they disagreed
 * on the format, and the guard meant to catch a stale index instead refused to
 * boot against a perfectly good one.
 */
export function embeddingIdentity(modelId: string, dimensions: number): string {
  return `${modelId}:${dimensions}`;
}

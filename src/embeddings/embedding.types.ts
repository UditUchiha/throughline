export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly modelId: string;
}

export const EMBEDDING_SERVICE = Symbol('EMBEDDING_SERVICE');

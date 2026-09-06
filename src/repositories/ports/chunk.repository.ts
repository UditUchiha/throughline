import { Chunk, CorpusSource } from '../../common/types/knowledge.types';

/** The per-chunk payload `insertMany` writes. Named so the adapter cannot restate it differently. */
export interface NewChunk {
  chunkIndex: number;
  text: string;
  /**
   * `CorpusSource`, not `string`. The tools know the source exactly and `Chunk`
   * declares it exactly; only the port in between used to widen it, which meant
   * the adapter had to cast on the way back out and any typo reached the database
   * unchallenged.
   */
  source: CorpusSource | null;
  docId: string | null;
}

export interface ChunkRepository {
  insertMany(articleId: number, chunks: NewChunk[]): Promise<Chunk[]>;
  findById(id: number): Promise<Chunk | null>;
  findByIds(ids: number[]): Promise<Chunk[]>;
  findByArticleId(articleId: number): Promise<Chunk[]>;
  deleteByArticleId(articleId: number): Promise<void>;
}

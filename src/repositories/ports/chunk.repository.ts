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
  /**
   * Every chunk in the index, ordered by id.
   *
   * Unbounded on purpose and only safe because of what calls it: the conflict
   * scanner, a batch job that by definition has to consider the whole corpus —
   * asking "what in here disagrees with itself" over a page of it is not a
   * smaller version of the question, it is a different one. At 172 chunks the
   * whole corpus is well under a megabyte. A corpus large enough for that to
   * hurt needs cursored iteration, which is a change to make when a second
   * caller exists rather than now (PLAN.md §0.4).
   */
  findAll(): Promise<Chunk[]>;
  findById(id: number): Promise<Chunk | null>;
  findByIds(ids: number[]): Promise<Chunk[]>;
  findByArticleId(articleId: number): Promise<Chunk[]>;
  deleteByArticleId(articleId: number): Promise<void>;
}

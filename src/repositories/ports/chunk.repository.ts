import { Chunk } from '../../common/types/knowledge.types';

export interface ChunkRepository {
  insertMany(
    articleId: number,
    chunks: { chunkIndex: number; text: string; source: string | null; docId: string | null }[],
  ): Promise<Chunk[]>;
  findById(id: number): Promise<Chunk | null>;
  findByIds(ids: number[]): Promise<Chunk[]>;
  findByArticleId(articleId: number): Promise<Chunk[]>;
  deleteByArticleId(articleId: number): Promise<void>;
}

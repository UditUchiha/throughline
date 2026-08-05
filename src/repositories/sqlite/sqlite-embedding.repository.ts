import { Inject, Injectable } from '@nestjs/common';
import Database from 'better-sqlite3';
import { SQLITE_CONNECTION } from '../../database/database.constants';
import { EmbeddingRepository, EmbeddingSearchHit } from '../ports/embedding.repository';

interface VecRow {
  chunk_id: number;
  distance: number;
}

@Injectable()
export class SqliteEmbeddingRepository implements EmbeddingRepository {
  constructor(@Inject(SQLITE_CONNECTION) private readonly db: Database.Database) {}

  async insertMany(entries: { chunkId: number; embedding: number[] }[]): Promise<void> {
    const insert = this.db.prepare('INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)');
    const insertAll = this.db.transaction((rows: typeof entries) => {
      for (const row of rows) {
        insert.run(BigInt(row.chunkId), JSON.stringify(row.embedding));
      }
    });
    insertAll(entries);
  }

  async deleteByChunkIds(chunkIds: number[]): Promise<void> {
    if (chunkIds.length === 0) return;
    const del = this.db.prepare('DELETE FROM vec_chunks WHERE chunk_id = ?');
    const deleteAll = this.db.transaction((ids: number[]) => {
      for (const id of ids) del.run(BigInt(id));
    });
    deleteAll(chunkIds);
  }

  async search(queryEmbedding: number[], topK: number): Promise<EmbeddingSearchHit[]> {
    const rows = this.db
      .prepare<[string, number], VecRow>(
        `SELECT chunk_id, distance FROM vec_chunks
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`,
      )
      .all(JSON.stringify(queryEmbedding), topK);
    return rows.map((r) => ({ chunkId: r.chunk_id, distance: r.distance }));
  }
}

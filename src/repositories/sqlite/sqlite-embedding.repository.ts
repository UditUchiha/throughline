import { Inject, Injectable } from '@nestjs/common';
import Database from 'better-sqlite3';
import { SQLITE_CONNECTION } from '../../database/database.constants';
import type { CorpusSource } from '../../common/types/knowledge.types';
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

  async search(
    queryEmbedding: number[],
    topK: number,
    sourceFilter?: CorpusSource[],
  ): Promise<EmbeddingSearchHit[]> {
    if (!sourceFilter || sourceFilter.length === 0) {
      // Unfiltered: fast path, direct vec0 query.
      const rows = this.db
        .prepare<[string, number], VecRow>(
          `SELECT chunk_id, distance FROM vec_chunks
           WHERE embedding MATCH ? AND k = ?
           ORDER BY distance`,
        )
        .all(JSON.stringify(queryEmbedding), topK);
      return rows.map((r) => ({ chunkId: r.chunk_id, distance: r.distance }));
    }

    // sqlite-vec's vec0 virtual table supports neither JOINs nor a WHERE on
    // non-vector columns, so a filtered search has to over-fetch by vector
    // distance and then post-filter against `chunks.source`.
    //
    // The subtlety is that a fixed over-fetch silently under-returns: if the
    // requested source is sparse among the nearest neighbours, the top-N window
    // can contain fewer than topK matching chunks — or none at all — while
    // perfectly relevant chunks of that source sit just outside it. A caller
    // asking mail_search for 5 results would get 2, with no indication that the
    // shortfall was an artifact of the window rather than the corpus.
    //
    // So widen until we either satisfy topK or provably exhaust the candidates:
    // once k reaches the number of rows in vec_chunks, the window is the entire
    // index and a short result set is the real answer.
    const placeholders = sourceFilter.map(() => '?').join(',');
    const allowedIds = new Set(
      this.db
        .prepare<string[], { chunk_id: number }>(
          `SELECT id AS chunk_id FROM chunks WHERE source IN (${placeholders})`,
        )
        .all(...sourceFilter)
        .map((r) => r.chunk_id),
    );
    if (allowedIds.size === 0) return [];

    const totalVectors = this.db
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM vec_chunks`)
      .get()!.n;

    const knn = this.db.prepare<[string, number], VecRow>(
      `SELECT chunk_id, distance FROM vec_chunks
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance`,
    );
    const queryJson = JSON.stringify(queryEmbedding);

    let k = Math.min(topK * 4, totalVectors);
    for (;;) {
      const matches = knn
        .all(queryJson, k)
        .filter((r) => allowedIds.has(r.chunk_id))
        .slice(0, topK);

      if (matches.length >= topK || k >= totalVectors) {
        return matches.map((r) => ({ chunkId: r.chunk_id, distance: r.distance }));
      }
      k = Math.min(k * 4, totalVectors);
    }
  }

  async neighbours(chunkId: number, topK: number): Promise<EmbeddingSearchHit[]> {
    if (topK <= 0) return [];

    const row = this.db
      .prepare<[bigint], { embedding: Buffer }>(
        'SELECT embedding FROM vec_chunks WHERE chunk_id = ?',
      )
      .get(BigInt(chunkId));
    if (!row) return [];

    // vec0 hands the vector back as the raw little-endian float32 buffer it
    // stores, not as the JSON that went in, so it has to be decoded before it
    // can be sent back as a query. `byteOffset` and a length in *floats* are
    // both required: Node pools small Buffers inside a larger ArrayBuffer, so a
    // bare `new Float32Array(row.embedding.buffer)` reads whichever neighbouring
    // allocations happen to share the pool.
    const vector = Array.from(
      new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / Float32Array.BYTES_PER_ELEMENT,
      ),
    );

    // Over-fetch by one and drop self: a chunk is always its own nearest
    // neighbour at distance 0, and vec0 has no way to exclude a rowid in the
    // MATCH. Without this every caller silently gets topK-1 real neighbours.
    return this.db
      .prepare<[string, number], VecRow>(
        `SELECT chunk_id, distance FROM vec_chunks
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`,
      )
      .all(JSON.stringify(vector), topK + 1)
      .filter((r) => r.chunk_id !== chunkId)
      .slice(0, topK)
      .map((r) => ({ chunkId: r.chunk_id, distance: r.distance }));
  }
}

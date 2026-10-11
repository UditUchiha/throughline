import { Inject, Injectable } from '@nestjs/common';
import Database from 'better-sqlite3';
import { SQLITE_CONNECTION } from '../../database/database.constants';
import { Chunk, isCorpusSource } from '../../common/types/knowledge.types';
import { ChunkRepository, NewChunk } from '../ports/chunk.repository';

interface ChunkRow {
  id: number;
  article_id: number;
  chunk_index: number;
  text: string;
  source: string | null;
  doc_id: string | null;
}

function toChunk(row: ChunkRow): Chunk {
  return {
    id: row.id,
    articleId: row.article_id,
    chunkIndex: row.chunk_index,
    text: row.text,
    // Validated rather than cast. `source` is a plain TEXT column with no CHECK
    // constraint, so anything can be in it — an older schema, a hand-edited row,
    // a future source this build does not know about. A cast would hand that
    // string onwards as a `CorpusSource` and it would end up indexing
    // `SOURCE_STYLES` in the UI, which is the crash CLAUDE.md records for the
    // closed-union era. Unrecognised reads as "no source", which every consumer
    // already handles because `source` is nullable.
    source: isCorpusSource(row.source) ? row.source : null,
    docId: row.doc_id,
  };
}

@Injectable()
export class SqliteChunkRepository implements ChunkRepository {
  constructor(@Inject(SQLITE_CONNECTION) private readonly db: Database.Database) {}

  async insertMany(articleId: number, chunks: NewChunk[]): Promise<Chunk[]> {
    const insert = this.db.prepare<
      [number, number, string, string | null, string | null],
      ChunkRow
    >(
      `INSERT INTO chunks (article_id, chunk_index, text, source, doc_id) VALUES (?, ?, ?, ?, ?) RETURNING *`,
    );

    const insertAll = this.db.transaction((rows: NewChunk[]) => {
      return rows.map((c) => insert.get(articleId, c.chunkIndex, c.text, c.source, c.docId)!);
    });

    return insertAll(chunks).map(toChunk);
  }

  async findAll(): Promise<Chunk[]> {
    return this.db.prepare<[], ChunkRow>('SELECT * FROM chunks ORDER BY id').all().map(toChunk);
  }

  async findById(id: number): Promise<Chunk | null> {
    const row = this.db.prepare<[number], ChunkRow>('SELECT * FROM chunks WHERE id = ?').get(id);
    return row ? toChunk(row) : null;
  }

  async findByIds(ids: number[]): Promise<Chunk[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare<number[], ChunkRow>(`SELECT * FROM chunks WHERE id IN (${placeholders})`)
      .all(...ids);
    return rows.map(toChunk);
  }

  async findByArticleId(articleId: number): Promise<Chunk[]> {
    const rows = this.db
      .prepare<[number], ChunkRow>('SELECT * FROM chunks WHERE article_id = ? ORDER BY chunk_index')
      .all(articleId);
    return rows.map(toChunk);
  }

  async deleteByArticleId(articleId: number): Promise<void> {
    this.db.prepare('DELETE FROM chunks WHERE article_id = ?').run(articleId);
  }
}

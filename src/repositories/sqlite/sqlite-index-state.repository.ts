import { Inject, Injectable } from '@nestjs/common';
import Database from 'better-sqlite3';
import { SQLITE_CONNECTION } from '../../database/database.constants';
import { IndexState } from '../../common/types/knowledge.types';
import { IndexStateRepository } from '../ports/index-state.repository';

interface IndexStateRow {
  path: string;
  last_indexed: string;
  checksum: string;
}

function toIndexState(row: IndexStateRow): IndexState {
  return {
    path: row.path,
    lastIndexed: row.last_indexed,
    checksum: row.checksum,
  };
}

@Injectable()
export class SqliteIndexStateRepository implements IndexStateRepository {
  constructor(@Inject(SQLITE_CONNECTION) private readonly db: Database.Database) {}

  async get(path: string): Promise<IndexState | null> {
    const row = this.db
      .prepare<[string], IndexStateRow>('SELECT * FROM index_state WHERE path = ?')
      .get(path);
    return row ? toIndexState(row) : null;
  }

  async upsert(state: IndexState): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO index_state (path, last_indexed, checksum)
         VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           last_indexed = excluded.last_indexed,
           checksum = excluded.checksum`,
      )
      .run(state.path, state.lastIndexed, state.checksum);
  }

  async all(): Promise<IndexState[]> {
    const rows = this.db.prepare<[], IndexStateRow>('SELECT * FROM index_state').all();
    return rows.map(toIndexState);
  }

  async delete(path: string): Promise<void> {
    this.db.prepare('DELETE FROM index_state WHERE path = ?').run(path);
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO index_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  async getMeta(key: string): Promise<string | null> {
    const row = this.db
      .prepare<[string], { value: string }>('SELECT value FROM index_meta WHERE key = ?')
      .get(key);
    return row?.value ?? null;
  }
}

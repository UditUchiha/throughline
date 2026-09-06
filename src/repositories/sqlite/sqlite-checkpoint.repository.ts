import { Inject, Injectable } from '@nestjs/common';
import Database from 'better-sqlite3';
import { SQLITE_CONNECTION } from '../../database/database.constants';
import type { CheckpointRepository } from '../ports/checkpoint.repository';

/**
 * Prunes `SqliteSaver`'s own two tables.
 *
 * They are not in `migrations.ts` because the saver creates them itself, lazily,
 * on its first write — so this repository must tolerate their absence rather
 * than assume the schema. That is not defensive coding for its own sake: a boot
 * that has served no agent run yet genuinely has no checkpoint tables, and
 * pruning nothing is the correct answer there, not an error.
 *
 * Recency comes from `checkpoint_id`, which LangGraph mints as a time-ordered
 * UUIDv6 — lexicographic order is chronological order, so the newest checkpoint
 * of a session sorts last without a timestamp column the saver does not have.
 */
@Injectable()
export class SqliteCheckpointRepository implements CheckpointRepository {
  constructor(@Inject(SQLITE_CONNECTION) private readonly db: Database.Database) {}

  pruneToRecentSessions(limit: number): Promise<number> {
    if (!this.hasCheckpointTables()) return Promise.resolve(0);

    const stale = this.db
      .prepare<[number], { thread_id: string }>(
        `SELECT thread_id FROM checkpoints
           GROUP BY thread_id
           ORDER BY MAX(checkpoint_id) DESC
           LIMIT -1 OFFSET ?`,
      )
      .all(limit)
      .map((row) => row.thread_id);

    if (stale.length === 0) return Promise.resolve(0);

    const placeholders = stale.map(() => '?').join(', ');
    // `writes` has no foreign key to `checkpoints` — the saver declares none — so
    // it is deleted explicitly. Missing this leaves the pending writes of every
    // pruned session behind, which is most of the rows.
    const deleteCheckpoints = this.db.prepare(
      `DELETE FROM checkpoints WHERE thread_id IN (${placeholders})`,
    );
    const deleteWrites = this.db.prepare(`DELETE FROM writes WHERE thread_id IN (${placeholders})`);

    this.db.transaction(() => {
      deleteCheckpoints.run(...stale);
      deleteWrites.run(...stale);
    })();

    return Promise.resolve(stale.length);
  }

  private hasCheckpointTables(): boolean {
    const row = this.db
      .prepare<[], { count: number }>(
        `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name IN ('checkpoints', 'writes')`,
      )
      .get();

    return row?.count === 2;
  }
}

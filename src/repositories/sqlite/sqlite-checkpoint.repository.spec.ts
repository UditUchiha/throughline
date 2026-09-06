import Database from 'better-sqlite3';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
// Re-exported by `@langchain/langgraph` rather than imported from
// `@langchain/langgraph-checkpoint` directly, which is a transitive dependency
// this package does not declare.
import { emptyCheckpoint, type CheckpointMetadata } from '@langchain/langgraph';
import { SqliteCheckpointRepository } from './sqlite-checkpoint.repository';

const METADATA: CheckpointMetadata = { source: 'loop', step: 1, parents: {} };

/**
 * Writes through the real `SqliteSaver` rather than hand-rolling INSERTs.
 *
 * The tables under test are not in `migrations.ts` — the saver owns them — so a
 * spec that created its own copy of the schema would keep passing after the
 * saver changed it, which is the one failure this spec exists to catch.
 */
async function writeCheckpoint(saver: SqliteSaver, threadId: string): Promise<void> {
  const checkpoint = emptyCheckpoint();
  const config = await saver.put({ configurable: { thread_id: threadId } }, checkpoint, METADATA);
  await saver.putWrites(config, [['answer', 'anything']], `task-${threadId}`);
}

describe('SqliteCheckpointRepository', () => {
  let db: Database.Database;
  let saver: SqliteSaver;
  let repo: SqliteCheckpointRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    saver = new SqliteSaver(db);
    repo = new SqliteCheckpointRepository(db);
  });

  afterEach(() => db.close());

  it('prunes nothing before the saver has created its tables', async () => {
    // A boot that has served no agent run genuinely has no checkpoint tables,
    // because the saver creates them lazily on its first write. Throwing there
    // would fail the first run of every fresh deployment.
    await expect(repo.pruneToRecentSessions(10)).resolves.toBe(0);
  });

  it('keeps the most recently written sessions and drops the rest', async () => {
    for (const threadId of ['s1', 's2', 's3', 's4']) {
      await writeCheckpoint(saver, threadId);
    }

    await expect(repo.pruneToRecentSessions(2)).resolves.toBe(2);

    const remaining = db
      .prepare<[], { thread_id: string }>('SELECT DISTINCT thread_id FROM checkpoints')
      .all()
      .map((row) => row.thread_id)
      .sort();

    // Recency is read off `checkpoint_id`, a time-ordered UUIDv6 — the saver has
    // no timestamp column, so the ordering is only correct because those ids sort
    // chronologically.
    expect(remaining).toEqual(['s3', 's4']);
  });

  it('deletes a pruned session pending writes too', async () => {
    for (const threadId of ['s1', 's2']) {
      await writeCheckpoint(saver, threadId);
    }

    await repo.pruneToRecentSessions(1);

    // `writes` has no foreign key to `checkpoints`, so nothing cascades. Missing
    // this leaves behind most of the rows a pruned session occupied.
    const orphans = db
      .prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM writes WHERE thread_id = 's1'`)
      .get();
    expect(orphans?.count).toBe(0);
  });

  it('leaves the store alone when it is already within the bound', async () => {
    await writeCheckpoint(saver, 's1');

    await expect(repo.pruneToRecentSessions(5)).resolves.toBe(0);
    expect(
      db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM checkpoints').get()?.count,
    ).toBeGreaterThan(0);
  });

  it('counts a session once however many checkpoints it wrote', async () => {
    // One run writes a checkpoint per superstep, so the retention unit has to be
    // the session — a limit that counted rows would keep a single conversation
    // and call it a hundred.
    for (let step = 0; step < 5; step += 1) await writeCheckpoint(saver, 's1');
    await writeCheckpoint(saver, 's2');

    await expect(repo.pruneToRecentSessions(2)).resolves.toBe(0);
    await expect(repo.pruneToRecentSessions(1)).resolves.toBe(1);

    const remaining = db
      .prepare<[], { thread_id: string }>('SELECT DISTINCT thread_id FROM checkpoints')
      .all()
      .map((row) => row.thread_id);
    expect(remaining).toEqual(['s2']);
  });
});

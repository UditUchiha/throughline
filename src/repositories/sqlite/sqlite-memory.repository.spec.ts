import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from '../../database/migrations';
import { SqliteMemoryRepository } from './sqlite-memory.repository';
import type { MemoryCandidate } from '../../memory/memory.types';

const DIMS = 8;
const ORIGIN = { runId: 'run-1', sessionId: 'session-1' };

function memoryDb(): Database.Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  // Eight dimensions rather than the real 768: this suite is about the SQL and
  // the two-table bookkeeping, and hand-written vectors are only readable small.
  runMigrations(db, DIMS);
  return db;
}

/** A unit vector along one axis, so distances between them are predictable. */
function axis(index: number, magnitude = 1): number[] {
  return Array.from({ length: DIMS }, (_, i) => (i === index ? magnitude : 0));
}

function candidate(text: string, overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return { text, kind: 'preference', importance: 0.8, ...overrides };
}

describe('SqliteMemoryRepository', () => {
  let db: Database.Database;
  let repo: SqliteMemoryRepository;

  beforeEach(() => {
    db = memoryDb();
    repo = new SqliteMemoryRepository(db);
  });

  afterEach(() => db.close());

  it('stores a fact and finds it again by vector', async () => {
    const stored = await repo.insert(
      candidate('The user prefers concise answers.'),
      axis(0),
      ORIGIN,
    );

    expect(stored.id).toBeGreaterThan(0);
    expect(stored.accessCount).toBe(1);
    expect(stored.lastUsedAt).toBeNull();

    const hits = await repo.search(axis(0), 3);
    expect(hits).toHaveLength(1);
    expect(hits[0].fact.text).toBe('The user prefers concise answers.');
    expect(hits[0].distance).toBeCloseTo(0, 5);
  });

  it('returns nearest facts in distance order', async () => {
    await repo.insert(candidate('near'), axis(0), ORIGIN);
    await repo.insert(candidate('far'), axis(1), ORIGIN);

    const hits = await repo.search(axis(0, 0.9), 2);
    expect(hits.map((hit) => hit.fact.text)).toEqual(['near', 'far']);
    expect(hits[0].distance).toBeLessThan(hits[1].distance);
  });

  it('increments the counter on a restatement instead of storing again', async () => {
    const stored = await repo.insert(
      candidate('The user prefers concise answers.'),
      axis(0),
      ORIGIN,
    );

    const first = await repo.recordRestatement(stored.id);
    const second = await repo.recordRestatement(stored.id);

    // The M4 acceptance criterion, at the storage layer: one row, counter moving.
    expect(first?.accessCount).toBe(2);
    expect(second?.accessCount).toBe(3);
    expect(await repo.countFacts()).toBe(1);
  });

  it('reports a restatement of a fact that is gone rather than resurrecting it', async () => {
    const stored = await repo.insert(candidate('doomed'), axis(0), ORIGIN);
    await repo.delete([stored.id]);

    // Consolidation can delete a fact between a dedup search and its update. The
    // caller needs to know so it can store the candidate instead.
    expect(await repo.recordRestatement(stored.id)).toBeNull();
  });

  it('deletes the vector alongside the fact', async () => {
    const stored = await repo.insert(candidate('forget me'), axis(0), ORIGIN);
    await repo.delete([stored.id]);

    // Nothing cascades into a vec0 virtual table, so a missed delete here leaves
    // a hit that resolves to no fact — a phantom that survives every later query.
    const orphans = db
      .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM vec_memory_facts')
      .get();
    expect(orphans?.n).toBe(0);
    expect(await repo.search(axis(0), 3)).toEqual([]);
  });

  it('separates being searched from being used', async () => {
    const stored = await repo.insert(
      candidate('The user prefers concise answers.'),
      axis(0),
      ORIGIN,
    );

    await repo.search(axis(0), 1);
    expect((await repo.all())[0].lastUsedAt).toBeNull();

    // Dedup searches this index on every candidate. If that counted as use, a
    // fact would stay alive on near-misses it was never actually chosen for.
    await repo.markUsed([stored.id]);
    expect((await repo.all())[0].lastUsedAt).not.toBeNull();
  });

  it('ages a never-used fact by when it was created', async () => {
    await repo.insert(candidate('never used'), axis(0), ORIGIN);
    const used = await repo.insert(candidate('used'), axis(1), ORIGIN);
    await repo.markUsed([used.id]);

    const stale = await repo.findUnusedSince('2999-01-01T00:00:00.000Z');
    expect(stale.map((fact) => fact.text).sort()).toEqual(['never used', 'used']);

    // The point of the COALESCE: without it a fact nobody ever retrieved would
    // have a null timestamp, fail every comparison, and become immortal —
    // exactly the fact most worth forgetting.
    const none = await repo.findUnusedSince('2000-01-01T00:00:00.000Z');
    expect(none).toEqual([]);
  });

  it('accumulates funnel counters and reports unfired stages as zero', async () => {
    await repo.incrementFunnel('proposed', 3);
    await repo.incrementFunnel('proposed');
    await repo.incrementFunnel('stored');

    // A stage that has never fired must read 0, not go missing: the funnel is
    // only interpretable if every stage is present.
    expect(await repo.funnel()).toEqual({
      skippedNoSelfReference: 0,
      proposed: 4,
      droppedLowImportance: 0,
      mergedDuplicate: 0,
      stored: 1,
    });
  });

  it('keeps an unknown stored kind readable', async () => {
    await repo.insert(candidate('odd', { kind: 'preference' }), axis(0), ORIGIN);
    db.prepare('UPDATE memory_facts SET kind = ?').run('something-new');

    // Same reasoning as `toSpanKind`: a row written by a future version should
    // read as the harmless kind rather than crash or be asserted into a lie.
    expect((await repo.all())[0].kind).toBe('preference');
  });
});

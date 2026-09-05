import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from '../../database/migrations';
import { SqliteTraceRepository } from './sqlite-trace.repository';
import type { PersistedRun, RunSpan } from '../../common/types/trace.types';
import type { EmittedAgentEvent } from '../../agent/events';
import type { AppConfigService } from '../../config/app-config.service';

function memoryDb(): Database.Database {
  const db = new Database(':memory:');
  // `runMigrations` creates a vec0 virtual table, which needs the extension even
  // though nothing in this suite touches vectors.
  sqliteVec.load(db);
  runMigrations(db, 768);
  return db;
}

const EVENTS: EmittedAgentEvent[] = [
  { type: 'run_started', runId: 'run-1', question: 'why?', seq: 0, ts: '2026-09-05T10:00:00.000Z' },
  {
    type: 'triage_done',
    complexity: 'complex',
    reasoning: 'two parts',
    seq: 1,
    ts: '2026-09-05T10:00:01.000Z',
  },
];

function run(overrides: Partial<PersistedRun> = {}): PersistedRun {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    question: 'why did it slip?',
    startedAt: '2026-09-05T10:00:00.000Z',
    finishedAt: '2026-09-05T10:00:05.000Z',
    status: 'finished',
    answer: {
      text: 'because [1]',
      citations: [{ marker: 1, evidenceId: 'ev-7' }],
      abstained: false,
    },
    citations: [{ marker: 1, evidenceId: 'ev-7' }],
    events: EVENTS,
    usage: { inputTokens: 4_300, outputTokens: 512 },
    costUsd: 0.0021,
    latencyMs: 5_000,
    models: ['gemini/gemini-3.5-flash', 'groq/openai/gpt-oss-20b'],
    error: null,
    ...overrides,
  };
}

const SPANS: RunSpan[] = [
  {
    spanId: 'root',
    parentSpanId: null,
    name: 'agent_run',
    kind: 'run',
    startedAt: '2026-09-05T10:00:00.000Z',
    endedAt: '2026-09-05T10:00:05.000Z',
    durationMs: 5_000,
    error: null,
    attributes: { status: 'finished' },
  },
  {
    spanId: 'node-1',
    parentSpanId: 'root',
    name: 'execute',
    kind: 'node',
    startedAt: '2026-09-05T10:00:01.000Z',
    endedAt: '2026-09-05T10:00:02.000Z',
    durationMs: 1_000,
    error: null,
    attributes: {},
  },
  {
    spanId: 'tool-1',
    parentSpanId: 'node-1',
    name: 'mail_search',
    kind: 'tool',
    startedAt: '2026-09-05T10:00:01.100Z',
    endedAt: '2026-09-05T10:00:01.700Z',
    durationMs: 600,
    error: null,
    attributes: { subQuestionId: 'sq1', evidenceCount: 5 },
  },
];

/** SPANS re-keyed for a given run, the way `randomUUID` does in production. */
function spansFor(runId: string): RunSpan[] {
  return SPANS.map((span) => ({
    ...span,
    spanId: `${runId}-${span.spanId}`,
    parentSpanId: span.parentSpanId === null ? null : `${runId}-${span.parentSpanId}`,
  }));
}

function repoWith(db: Database.Database, traceRetentionRuns = 200): SqliteTraceRepository {
  return new SqliteTraceRepository(db, { traceRetentionRuns } as AppConfigService);
}

describe('SqliteTraceRepository', () => {
  let db: Database.Database;
  let repo: SqliteTraceRepository;

  beforeEach(() => {
    db = memoryDb();
    repo = repoWith(db);
  });

  afterEach(() => db.close());

  it('round-trips a run with its spans', async () => {
    await repo.save(run(), SPANS);

    const found = await repo.get('run-1');

    expect(found?.run).toEqual(run());
    expect(found?.spans).toHaveLength(3);
  });

  it('preserves the event stream exactly, so the run stays replayable', async () => {
    await repo.save(run(), SPANS);

    // The endpoint's contract is a *replayable* run, and the event stream is the
    // run. A lossy round-trip here would be invisible until someone replayed one.
    expect((await repo.get('run-1'))?.run.events).toEqual(EVENTS);
  });

  it('keeps an unpriced run distinguishable from a free one', async () => {
    await repo.save(run({ runId: 'unpriced', costUsd: null }), []);
    await repo.save(run({ runId: 'free', costUsd: 0 }), []);

    expect((await repo.get('unpriced'))?.run.costUsd).toBeNull();
    expect((await repo.get('free'))?.run.costUsd).toBe(0);
  });

  it('stores a failed run with no answer', async () => {
    await repo.save(
      run({ runId: 'failed-run', status: 'failed', answer: null, error: 'quota exhausted' }),
      [],
    );

    const found = await repo.get('failed-run');
    expect(found?.run).toMatchObject({ status: 'failed', answer: null, error: 'quota exhausted' });
  });

  it('returns null for a run it does not have', async () => {
    expect(await repo.get('never-happened')).toBeNull();
  });

  it('does not return spans belonging to another run', async () => {
    await repo.save(run(), SPANS);
    await repo.save(run({ runId: 'run-2' }), [{ ...SPANS[0], spanId: 'root-2' }]);

    expect((await repo.get('run-2'))?.spans.map((span) => span.spanId)).toEqual(['root-2']);
  });

  it('is idempotent, so a retried save cannot duplicate spans', async () => {
    await repo.save(run(), SPANS);
    await repo.save(run(), SPANS);

    expect((await repo.get('run-1'))?.spans).toHaveLength(3);
  });

  it('keeps only the most recent runs, dropping the oldest', async () => {
    // The store this replaced was capped at 100 and emptied on restart. Durable
    // and unbounded would have been a log, not a buffer — and §9 ships this file.
    const capped = repoWith(db, 3);

    for (let i = 1; i <= 5; i++) {
      await capped.save(
        run({ runId: `run-${i}`, startedAt: new Date(Date.UTC(2026, 8, 5, 10, i)).toISOString() }),
        [],
      );
    }

    expect(await capped.get('run-1')).toBeNull();
    expect(await capped.get('run-2')).toBeNull();
    expect(await capped.get('run-5')).not.toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS c FROM runs').get()).toEqual({ c: 3 });
  });

  it('takes the spans of a pruned run with it rather than orphaning them', async () => {
    // Relies on ON DELETE CASCADE, which only fires because DatabaseModule sets
    // `foreign_keys = ON`. Without that the rows would be silently stranded.
    const capped = repoWith(db, 1);

    await capped.save(
      run({ runId: 'old', startedAt: '2026-09-05T10:00:00.000Z' }),
      spansFor('old'),
    );
    await capped.save(
      run({ runId: 'new', startedAt: '2026-09-05T11:00:00.000Z' }),
      spansFor('new'),
    );

    expect(await capped.get('old')).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS c FROM run_spans WHERE run_id = 'old'").get()).toEqual({
      c: 0,
    });
    expect((await capped.get('new'))?.spans).toHaveLength(3);
  });
});

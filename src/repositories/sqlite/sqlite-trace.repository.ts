import { Inject, Injectable } from '@nestjs/common';
import Database from 'better-sqlite3';
import { SQLITE_CONNECTION } from '../../database/database.constants';
import { AppConfigService } from '../../config/app-config.service';
import type { PersistedRun, RunSpan, SpanKind } from '../../common/types/trace.types';
import type { TraceRepository } from '../ports/trace.repository';
import type { AgentAnswer, Citation } from '../../agent/agent.types';
import type { EmittedAgentEvent } from '../../agent/events';

interface RunRow {
  run_id: string;
  session_id: string;
  question: string;
  started_at: string;
  finished_at: string;
  status: string;
  answer_json: string | null;
  citations_json: string;
  events_json: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  latency_ms: number;
  models_json: string;
  error: string | null;
}

interface SpanRow {
  span_id: string;
  run_id: string;
  parent_span_id: string | null;
  name: string;
  kind: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  error: string | null;
  attributes_json: string;
}

@Injectable()
export class SqliteTraceRepository implements TraceRepository {
  constructor(
    @Inject(SQLITE_CONNECTION) private readonly db: Database.Database,
    private readonly config: AppConfigService,
  ) {}

  async save(run: PersistedRun, spans: RunSpan[]): Promise<void> {
    const insertRun = this.db.prepare(
      `INSERT INTO runs (
         run_id, session_id, question, started_at, finished_at, status,
         answer_json, citations_json, events_json, input_tokens, output_tokens,
         cost_usd, latency_ms, models_json, error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO NOTHING`,
    );

    const insertSpan = this.db.prepare(
      `INSERT INTO run_spans (
         span_id, run_id, parent_span_id, name, kind,
         started_at, ended_at, duration_ms, error, attributes_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(span_id) DO NOTHING`,
    );

    // One transaction so a run is never readable without its spans — the endpoint
    // returns both, and a half-written trace would look like a run that did nothing.
    this.db.transaction(() => {
      insertRun.run(
        run.runId,
        run.sessionId,
        run.question,
        run.startedAt,
        run.finishedAt,
        run.status,
        run.answer === null ? null : JSON.stringify(run.answer),
        JSON.stringify(run.citations),
        JSON.stringify(run.events),
        run.usage.inputTokens,
        run.usage.outputTokens,
        run.costUsd,
        run.latencyMs,
        JSON.stringify(run.models),
        run.error,
      );

      for (const span of spans) {
        insertSpan.run(
          span.spanId,
          run.runId,
          span.parentSpanId,
          span.name,
          span.kind,
          span.startedAt,
          span.endedAt,
          span.durationMs,
          span.error,
          JSON.stringify(span.attributes),
        );
      }

      // Prune inside the same transaction as the insert, so the table is never
      // observably over the cap. `run_spans` follows via ON DELETE CASCADE —
      // `foreign_keys` is switched on in DatabaseModule, without which this would
      // silently orphan every pruned run's spans.
      this.db
        .prepare(
          `DELETE FROM runs WHERE run_id IN (
             SELECT run_id FROM runs ORDER BY started_at DESC LIMIT -1 OFFSET ?
           )`,
        )
        .run(this.config.traceRetentionRuns);
    })();
  }

  async get(runId: string): Promise<{ run: PersistedRun; spans: RunSpan[] } | null> {
    const row = this.db.prepare<[string], RunRow>('SELECT * FROM runs WHERE run_id = ?').get(runId);
    if (!row) return null;

    const spanRows = this.db
      .prepare<[string], SpanRow>(
        'SELECT * FROM run_spans WHERE run_id = ? ORDER BY started_at ASC, duration_ms DESC',
      )
      .all(runId);

    return { run: toPersistedRun(row), spans: spanRows.map(toRunSpan) };
  }
}

function toPersistedRun(row: RunRow): PersistedRun {
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    question: row.question,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status === 'failed' ? 'failed' : 'finished',
    answer: row.answer_json === null ? null : parseJson<AgentAnswer | null>(row.answer_json, null),
    citations: parseJson<Citation[]>(row.citations_json, []),
    events: parseJson<EmittedAgentEvent[]>(row.events_json, []),
    usage: { inputTokens: row.input_tokens, outputTokens: row.output_tokens },
    costUsd: row.cost_usd,
    latencyMs: row.latency_ms,
    models: parseJson<string[]>(row.models_json, []),
    error: row.error,
  };
}

function toRunSpan(row: SpanRow): RunSpan {
  return {
    spanId: row.span_id,
    parentSpanId: row.parent_span_id,
    name: row.name,
    kind: toSpanKind(row.kind),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    error: row.error,
    attributes: parseJson<Record<string, unknown>>(row.attributes_json, {}),
  };
}

/**
 * Narrows the stored kind rather than asserting it.
 *
 * The column carries a `CHECK` constraint, so an unknown value means the row
 * predates it or was written by hand — either way, inventing a kind is worse than
 * admitting the span is unclassified, and a cast would do exactly that silently.
 */
function toSpanKind(kind: string): SpanKind {
  const known: SpanKind[] = ['run', 'node', 'tool', 'llm'];
  return known.find((candidate) => candidate === kind) ?? 'run';
}

/**
 * These columns were written by `JSON.stringify` in this same file, so a parse
 * failure means the row is corrupt rather than merely unexpected. Returning the
 * empty value keeps one damaged run from making the endpoint throw for it — the
 * rest of the trace is still worth reading.
 */
function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

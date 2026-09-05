import type { PersistedRun, RunSpan } from '../../common/types/trace.types';

/**
 * Durable storage for finished agent runs and their spans.
 *
 * A run and its spans are written together and read back together because there
 * is no caller for one without the other — `GET /agent/runs/:runId` needs both,
 * and splitting them would be an abstraction ahead of its second use (§0.4).
 */
export interface TraceRepository {
  save(run: PersistedRun, spans: RunSpan[]): Promise<void>;
  get(runId: string): Promise<{ run: PersistedRun; spans: RunSpan[] } | null>;
}

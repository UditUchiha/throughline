import type { AgentAnswer, Citation, TokenUsage } from '../../agent/agent.types';
import type { EmittedAgentEvent } from '../../agent/events';

/**
 * What a span measures. Four kinds because that is what the system actually has
 * timings for — nothing here is inferred from the ordering of other events.
 *
 * - `run`   the whole request, and the root every other span hangs from
 * - `node`  one LangGraph node (triage, plan, execute, reflect, synthesize)
 * - `tool`  one retrieval call
 * - `llm`   one model call
 */
export type SpanKind = 'run' | 'node' | 'tool' | 'llm';

export interface RunSpan {
  spanId: string;
  /** `null` only for the root. */
  parentSpanId: string | null;
  name: string;
  kind: SpanKind;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** Present when the span failed; `null` is a success, not "unknown". */
  error: string | null;
  /** Kind-specific detail — model and tokens for `llm`, evidence count for `tool`. */
  attributes: Record<string, unknown>;
}

/**
 * A finished run, durable. Replaces the in-memory `AgentRunStore` that M1 used to
 * back `GET /agent/runs/:runId` (PLAN.md §5/M3.2).
 *
 * `events` is stored whole because the endpoint's contract is a *replayable* run:
 * the event stream is the run, and re-deriving it from spans would be a lossy
 * reconstruction of something already captured exactly.
 */
export interface PersistedRun {
  runId: string;
  sessionId: string;
  question: string;
  startedAt: string;
  finishedAt: string;
  status: 'finished' | 'failed';
  answer: AgentAnswer | null;
  citations: Citation[];
  events: EmittedAgentEvent[];
  usage: TokenUsage;
  costUsd: number | null;
  latencyMs: number;
  /** `provider/model`, first-use order. Empty when no model was called. */
  models: string[];
  /** Present when the run failed. */
  error: string | null;
}

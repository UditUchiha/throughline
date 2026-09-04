import type {
  AgentAnswer,
  Citation,
  Complexity,
  Evidence,
  MemoryRef,
  SubQuestion,
  TokenUsage,
} from './agent.types';

/**
 * The agent event contract.
 *
 * **Frozen in M1 on purpose (PLAN.md §4, §5/M1.4).** The graph emits these, the
 * HTTP layer forwards them verbatim over SSE, and M2's UI is pure rendering on
 * top. Adding a variant is cheap; changing or removing one breaks the UI, so
 * treat existing members as append-only.
 *
 * `memory_read` / `memory_written` are wired in M4 and emit empty until then.
 */
export type AgentEvent =
  | { type: 'run_started'; runId: string; question: string }
  /**
   * Always the first event of a replayed run, never emitted by a live one.
   *
   * This is the honesty mechanism for PLAN.md §9's recorded-run fallback: a
   * consumer cannot accidentally present a recording as a live run, because the
   * recording announces itself before any of its events arrive.
   */
  | {
      type: 'run_replayed';
      slug: string;
      question: string;
      capturedAt: string;
      reason: 'requested' | 'quota_exhausted';
    }
  | { type: 'triage_done'; complexity: Complexity; reasoning: string }
  | { type: 'plan_created'; subQuestions: SubQuestion[] }
  | { type: 'tool_started'; subQuestionId: string; tool: string; input: string }
  | {
      type: 'tool_finished';
      subQuestionId: string;
      tool: string;
      evidenceIds: string[];
      latencyMs: number;
    }
  | { type: 'evidence_added'; evidence: Evidence[] }
  | { type: 'reflect_done'; gapFound: boolean; followUps: SubQuestion[] }
  | { type: 'memory_read'; refs: MemoryRef[] }
  | { type: 'memory_written'; refs: MemoryRef[] }
  | { type: 'token_delta'; text: string }
  | {
      type: 'run_finished';
      answer: AgentAnswer;
      citations: Citation[];
      usage: TokenUsage;
      costUsd: number | null;
      latencyMs: number;
    }
  | { type: 'run_failed'; error: string };

export type AgentEventType = AgentEvent['type'];

/**
 * What a consumer actually receives. `seq` lets the UI detect gaps and order
 * events that arrive out of band; both fields are stamped by the emitter so no
 * node has to remember to set them.
 */
export type EmittedAgentEvent = AgentEvent & { seq: number; ts: string };

/** Sink handed to the graph by whoever started the run (SSE writer, test spy). */
export type AgentEventSink = (event: EmittedAgentEvent) => void;

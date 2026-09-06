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
 * `memory_read` / `memory_written` carry short-term (within-session) memory as of
 * M4.1; M4.2 adds long-term facts to the same two events.
 */
export type AgentEvent =
  | {
      type: 'run_started';
      runId: string;
      question: string;
      /**
       * The session this run belongs to — minted by the server when the caller
       * sends none, which is why the caller has to be *told* it rather than
       * assumed to know it. Sending it back on the next question is what makes a
       * follow-up a follow-up (PLAN.md §5/M4.1).
       *
       * Optional because the contract is append-only: the fixtures in
       * `fixtures/runs/` predate the field, and a replayed run has no session —
       * a recording is not a conversation.
       */
      sessionId?: string;
    }
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
      /**
       * Present only when the tool threw. Without it a failed retrieval is
       * indistinguishable on the wire from one that legitimately found nothing —
       * both carry an empty `evidenceIds` — and a consumer has no way to render
       * the sub-question as anything but done.
       *
       * Optional because the contract is append-only: the fixtures in
       * `fixtures/runs/` predate the field, and every one of them succeeded.
       */
      error?: string;
    }
  | { type: 'evidence_added'; evidence: Evidence[] }
  | { type: 'reflect_done'; gapFound: boolean; followUps: SubQuestion[] }
  | { type: 'memory_read'; refs: MemoryRef[] }
  | { type: 'memory_written'; refs: MemoryRef[] }
  /**
   * `recall` rewrote a follow-up into a standalone question before triage.
   *
   * Emitted only when the text actually changed, so its presence is the signal:
   * every other event in the run describes the *resolved* question, and without
   * this one a consumer would show an answer to "who approved it?" with no way
   * to tell whether the agent understood what "it" was.
   */
  | { type: 'followup_resolved'; original: string; resolved: string }
  | { type: 'token_delta'; text: string }
  | {
      type: 'run_finished';
      answer: AgentAnswer;
      citations: Citation[];
      usage: TokenUsage;
      costUsd: number | null;
      latencyMs: number;
      /**
       * `provider/model` for every model the run used, in first-use order.
       *
       * Optional because the contract is append-only and the fixtures in
       * `fixtures/runs/` were captured before this field existed — a replayed run
       * legitimately has no value here, and the UI shows nothing rather than
       * inventing one.
       */
      models?: string[];
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

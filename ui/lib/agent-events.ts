/**
 * A structural mirror of the agent's event contract.
 *
 * **The source of truth is `src/agent/events.ts` in the API**, which is frozen and
 * append-only (PLAN.md §4, §5/M1.4). This file is a hand-kept copy rather than an
 * import because the UI deploys to Vercel from `ui/` as its root and the API
 * deploys separately — reaching across the boundary at build time would couple two
 * deployments that are otherwise independent.
 *
 * If you add an event variant on the API side, add it here too. Every field is
 * read defensively at the parse boundary (`lib/sse.ts`), so a UI that has not
 * caught up ignores an unknown event rather than crashing on it.
 */

export type Complexity = 'simple' | 'complex';
/**
 * The three sources this build knows how to style.
 *
 * **Open, not a closed union**, and for the reason `QuestionCategory` in
 * `lib/api.ts` is: the API owns this vocabulary and can extend it. M5 added
 * connectors, and while today each one files its results under one of these
 * three, a connector that introduced a fourth would previously have reached
 * `SOURCE_STYLES[source]` as `undefined` and thrown on `.className` inside the
 * evidence panel — a hard crash in the UI from a value the API is entitled to
 * send. Unknown sources now render with their raw name instead.
 */
export const KNOWN_SOURCES = ['mail', 'chat', 'notes'] as const;

export type KnownSource = (typeof KNOWN_SOURCES)[number];
export type CorpusSource = KnownSource | (string & {});
export type SubQuestionStatus = 'pending' | 'running' | 'done' | 'failed';

export interface SubQuestion {
  id: string;
  text: string;
  tool: string;
  status: SubQuestionStatus;
  dependsOn?: string[];
  /** 0 for the initial plan; incremented for each reflect-driven follow-up. */
  hop: number;
  error?: string;
}

export interface Evidence {
  evidenceId: string;
  docId: string | null;
  source: CorpusSource | null;
  title: string;
  text: string;
  /** Raw vector distance — **lower is more similar**. Not a 0–1 score. */
  distance: number;
  retrievedBy: string;
  tool: string;
}

/** Binds an `[n]` marker in the answer text to a specific piece of evidence. */
export interface Citation {
  marker: number;
  evidenceId: string;
}

/** One thing memory handed the run, or one thing the run committed to it. */
export interface MemoryRef {
  id: string;
  kind: string;
  text: string;
}

export interface AgentAnswer {
  text: string;
  citations: Citation[];
  abstained: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type AgentEvent =
  | {
      type: 'run_started';
      runId: string;
      question: string;
      /**
       * The session this run belongs to. Send it back on the next question and
       * the API treats that question as a follow-up; drop it and every question
       * opens a new conversation. Absent on runs captured before the field
       * existed, and on a replay — a recording is not a conversation.
       */
      sessionId?: string;
    }
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
       * Set only when the tool threw. An empty `evidenceIds` alone means nothing —
       * a search can legitimately find no matches — so this is the only signal
       * that separates a failure from an empty result. Absent on the committed
       * fixtures, which all succeeded.
       */
      error?: string;
    }
  | { type: 'evidence_added'; evidence: Evidence[] }
  | { type: 'reflect_done'; gapFound: boolean; followUps: SubQuestion[] }
  | { type: 'memory_read'; refs: MemoryRef[] }
  | { type: 'memory_written'; refs: MemoryRef[] }
  /**
   * The question was a follow-up and was rewritten to stand on its own before
   * anything else ran. Emitted only when the text actually changed, so every
   * other event in the run describes `resolved` rather than `original`.
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
      /** Absent on runs captured before the field existed — render nothing, not a guess. */
      models?: string[];
    }
  | { type: 'run_failed'; error: string };

export type AgentEventType = AgentEvent['type'];

export type EmittedAgentEvent = AgentEvent & { seq: number; ts: string };

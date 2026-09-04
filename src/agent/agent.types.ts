import type { CorpusSource } from '../common/types/knowledge.types';

/**
 * Triage verdict. `simple` questions skip planning entirely and go straight to a
 * single retrieval — knowing when *not* to decompose is a measurable latency and
 * cost win, not a shortcut (PLAN.md §5, M1.3).
 */
export type Complexity = 'simple' | 'complex';

export type SubQuestionStatus = 'pending' | 'running' | 'done' | 'failed';

export interface SubQuestion {
  id: string;
  text: string;
  /** Name of the tool in the registry that should answer this. */
  tool: string;
  status: SubQuestionStatus;
  /** Ids of sub-questions that must complete first. Absent = independent. */
  dependsOn?: string[];
  /** 0 for the initial plan; incremented for each reflect-driven follow-up. */
  hop: number;
  /** Populated when status is `failed`. */
  error?: string;
}

/**
 * A retrieved chunk once it has entered agent state. The `evidenceId` is minted
 * on entry and never changes, which is what makes citation validity a
 * deterministic check rather than an LLM judgment (PLAN.md §4).
 */
export interface Evidence {
  evidenceId: string;
  docId: string | null;
  source: CorpusSource | null;
  title: string;
  text: string;
  /**
   * Raw sqlite-vec vector distance — **lower is more similar**. Named for what it
   * is rather than the `score` in PLAN.md's sketch, because the UI has to know
   * the direction to render it and a mislabelled scale is a silent bug.
   */
  distance: number;
  /** Id of the sub-question whose tool call produced this. */
  retrievedBy: string;
  tool: string;
}

/**
 * Binds an `[n]` marker in the answer text to a specific piece of evidence.
 * `marker` is 1-based and matches the numbering shown to the model.
 */
export interface Citation {
  marker: number;
  evidenceId: string;
}

/**
 * Long-term memory reference. Memory is M4 — this shape exists so the state and
 * the event contract can be frozen now, and is emitted empty until then.
 */
export interface MemoryRef {
  id: string;
  kind: string;
  text: string;
}

export interface AgentAnswer {
  text: string;
  citations: Citation[];
  /** True when the model declined to answer for lack of grounding. */
  abstained: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

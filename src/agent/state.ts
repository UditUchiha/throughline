import { Annotation } from '@langchain/langgraph';
import type {
  AgentAnswer,
  Complexity,
  Evidence,
  MemoryRef,
  SessionTurn,
  SubQuestion,
} from './agent.types';
import type { AgentEvent } from './events';

/**
 * How many turns of a session the checkpoint carries.
 *
 * This is both what `recall` may show the model and what every checkpoint of
 * every superstep has to serialise, which is why it is a small number rather
 * than "the whole conversation": a turn is a question plus an answer, and the
 * saver writes the full channel value on each of the ~7 supersteps a run takes.
 * Older turns fall off the front — a fifteen-minute-old exchange is not what a
 * pronoun refers to.
 */
const MAX_SESSION_TURNS = 8;

/**
 * Sub-questions arrive from two directions: `plan` creates them, `execute`
 * updates their status, and `reflect` appends follow-ups. Merging by id (rather
 * than replacing the array) means a node can return just the entries it touched.
 */
function mergeSubQuestions(current: SubQuestion[], update: SubQuestion[]): SubQuestion[] {
  const byId = new Map(current.map((sq) => [sq.id, sq]));
  for (const sq of update) {
    byId.set(sq.id, { ...byId.get(sq.id), ...sq });
  }
  return [...byId.values()];
}

/**
 * Two sub-questions retrieving the same chunk is normal and expected — it is a
 * signal of corroboration, not a bug. Deduping by `evidenceId` keeps the
 * citation numbering stable and stops the synthesis prompt from paying for the
 * same passage twice.
 */
function mergeEvidence(current: Evidence[], update: Evidence[]): Evidence[] {
  const seen = new Set(current.map((e) => e.evidenceId));
  const merged = [...current];
  for (const evidence of update) {
    if (seen.has(evidence.evidenceId)) continue;
    seen.add(evidence.evidenceId);
    merged.push(evidence);
  }
  return merged;
}

function append<T>(current: T[], update: T[]): T[] {
  return [...current, ...update];
}

function replace<T>(_current: T, update: T): T {
  return update;
}

/**
 * A channel that a new turn clears.
 *
 * M4.1 keys the checkpointer by `sessionId`, so a second question on the same
 * session resumes the *same* thread — and every reducer here merges or appends.
 * Left alone, turn two would inherit turn one's evidence, its finished
 * sub-questions and its spent hop budget, and answer the new question out of the
 * old question's retrieval. (Observed, not theorised: an unguarded second invoke
 * arrives at `execute` with the previous turn's evidence already in state.)
 *
 * Passing an empty array cannot express the reset, because "append nothing" is
 * what an empty array means to an appending reducer. `null` can, so `null` is
 * the reset signal on every per-turn channel and {@link NEW_TURN_RESET} is the
 * one place that sends it. What survives a turn boundary is exactly what is not
 * built this way: {@link AgentStateAnnotation.turns}.
 */
function perTurn<TValue>(merge: (current: TValue, update: TValue) => TValue, empty: () => TValue) {
  return {
    reducer: (current: TValue, update: TValue | null): TValue =>
      update === null ? empty() : merge(current, update),
    default: empty,
  };
}

export const AgentStateAnnotation = Annotation.Root({
  /**
   * The question the graph is answering — which is not always the one that was
   * typed. `recall` replaces it with the resolved, self-contained form when the
   * visitor asked a follow-up, so every node downstream reads a question that
   * stands on its own. See {@link AgentStateAnnotation.askedQuestion}.
   */
  question: Annotation<string>,
  /** Verbatim, as the visitor typed it. Never rewritten; recorded on the turn. */
  askedQuestion: Annotation<string>,
  sessionId: Annotation<string>,
  runId: Annotation<string>,

  complexity: Annotation<Complexity, Complexity | null>(
    perTurn<Complexity>(replace, () => 'complex'),
  ),

  subQuestions: Annotation<SubQuestion[], SubQuestion[] | null>(
    perTurn(mergeSubQuestions, () => []),
  ),

  evidence: Annotation<Evidence[], Evidence[] | null>(perTurn(mergeEvidence, () => [])),

  memoryUsed: Annotation<MemoryRef[], MemoryRef[] | null>(perTurn(append, () => [])),

  /** Guards the reflect → execute loop. Compared against `MAX_HOPS`. */
  hops: Annotation<number, number | null>(perTurn<number>(replace, () => 0)),

  answer: Annotation<AgentAnswer | null, AgentAnswer | null>(
    // `null` means "cleared for a new turn" here rather than "no update", which
    // is safe only because no node ever returns a null answer: `synthesize`
    // abstains with a real {@link AgentAnswer} instead.
    perTurn<AgentAnswer | null>(replace, () => null),
  ),

  events: Annotation<AgentEvent[], AgentEvent[] | null>(perTurn(append, () => [])),

  /**
   * The session's conversation, oldest first. The one channel that deliberately
   * outlives a turn — it *is* the short-term memory, written by `synthesize` and
   * read by `recall` (PLAN.md §5/M4.1).
   */
  turns: Annotation<SessionTurn[], SessionTurn[]>({
    reducer: (current, update) => [...current, ...update].slice(-MAX_SESSION_TURNS),
    default: () => [],
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;
export type AgentStateUpdate = typeof AgentStateAnnotation.Update;

/**
 * Sent with every turn's input to clear what belonged to the previous one.
 *
 * Enumerated rather than derived: a channel added later is *not* reset by
 * default, and the failure mode is a subtle wrong answer on turn two rather than
 * an error — so the list being explicit is what makes the omission visible in
 * review. See {@link perTurn}.
 */
export const NEW_TURN_RESET = {
  complexity: null,
  subQuestions: null,
  evidence: null,
  memoryUsed: null,
  hops: null,
  answer: null,
  events: null,
} as const satisfies Partial<AgentStateUpdate>;

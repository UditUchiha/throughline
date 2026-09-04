import { Annotation } from '@langchain/langgraph';
import type { AgentAnswer, Complexity, Evidence, MemoryRef, SubQuestion } from './agent.types';
import type { AgentEvent } from './events';

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

export const AgentStateAnnotation = Annotation.Root({
  question: Annotation<string>,
  sessionId: Annotation<string>,
  runId: Annotation<string>,

  complexity: Annotation<Complexity>({
    reducer: (current, update) => update ?? current,
    default: () => 'complex',
  }),

  subQuestions: Annotation<SubQuestion[], SubQuestion[]>({
    reducer: mergeSubQuestions,
    default: () => [],
  }),

  evidence: Annotation<Evidence[], Evidence[]>({
    reducer: mergeEvidence,
    default: () => [],
  }),

  memoryUsed: Annotation<MemoryRef[], MemoryRef[]>({
    reducer: append,
    default: () => [],
  }),

  /** Guards the reflect → execute loop. Compared against `MAX_HOPS`. */
  hops: Annotation<number>({
    reducer: (current, update) => update ?? current,
    default: () => 0,
  }),

  answer: Annotation<AgentAnswer | null>({
    reducer: (current, update) => update ?? current,
    default: () => null,
  }),

  events: Annotation<AgentEvent[], AgentEvent[]>({
    reducer: append,
    default: () => [],
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;
export type AgentStateUpdate = typeof AgentStateAnnotation.Update;

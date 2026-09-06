/**
 * What kind of durable thing a fact is (PLAN.md §5/M4.2 names all three).
 *
 * A closed set because it is offered to the extraction model as an enum, and the
 * three it lists are the ones worth remembering across sessions. Anything else a
 * conversation contains is either in the corpus already or is not durable.
 */
export const MEMORY_KINDS = ['preference', 'relationship', 'correction'] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** A durable fact, as stored. */
export interface MemoryFact {
  id: number;
  text: string;
  kind: MemoryKind;
  importance: number;
  /** Times this fact has been stated. Incremented on merge, never on read. */
  accessCount: number;
  createdAt: string;
  updatedAt: string;
  /** Last time the fact was retrieved *into a run*. Null until first used. */
  lastUsedAt: string | null;
  sourceRunId: string;
  sourceSessionId: string;
}

/** A fact the extractor proposed, before scoring or deduplication. */
export interface MemoryCandidate {
  text: string;
  kind: MemoryKind;
  importance: number;
}

/**
 * Cumulative counts through the retention funnel (PLAN.md §5/M4.2).
 *
 * The stages are exclusive: a candidate is counted in `proposed`, then in
 * exactly one of the three outcomes. `proposed - dropped - merged - stored`
 * should be 0, which is what makes the retention rate trustworthy rather than
 * three unrelated numbers.
 */
export interface MemoryFunnel {
  proposed: number;
  droppedLowImportance: number;
  mergedDuplicate: number;
  stored: number;
}

export type MemoryFunnelStage = keyof MemoryFunnel;

export const MEMORY_FUNNEL_STAGES: MemoryFunnelStage[] = [
  'proposed',
  'droppedLowImportance',
  'mergedDuplicate',
  'stored',
];

/**
 * The claim this whole funnel exists to support: *stored*, not *retained*.
 *
 * A merged candidate did survive — it bumped a counter on the fact it restated —
 * but it added nothing to the store, and "how much does this system choose to
 * keep" is the question being answered. Counting merges as kept would let a
 * system that stores one fact and re-merges it forever report 100% retention.
 */
export function retentionRate(funnel: MemoryFunnel): number | null {
  if (funnel.proposed === 0) return null;
  return funnel.stored / funnel.proposed;
}

import type {
  MemoryCandidate,
  MemoryFact,
  MemoryFunnel,
  MemoryFunnelStage,
} from '../../memory/memory.types';

export interface MemorySearchHit {
  fact: MemoryFact;
  /** L2 distance from the query vector — **lower is more similar**. */
  distance: number;
}

/**
 * Durable storage for long-term memory facts and the funnel counters.
 *
 * The embedding travels in and out as a plain `number[]`: the port says nothing
 * about `sqlite-vec`, and a caller that had to know would be the sqlite
 * dependency §0.3 forbids, one indirection further out.
 *
 * Counters live here rather than in a second port because they are written in
 * the same transaction as the facts they describe — a stored fact that failed to
 * increment `stored` would quietly understate the retention rate forever.
 */
export interface MemoryRepository {
  insert(candidate: MemoryCandidate, embedding: number[], origin: FactOrigin): Promise<MemoryFact>;

  /**
   * Nearest stored facts to a query vector, closest first.
   *
   * Does **not** touch `lastUsedAt`. Searching is how deduplication asks "have I
   * got this already", and letting that count as use would keep a fact alive
   * forever on the strength of near-misses it was never chosen for. Use
   * {@link markUsed} for that, from the one caller that actually injects facts
   * into a run.
   */
  search(embedding: number[], topK: number): Promise<MemorySearchHit[]>;

  /** Increments `accessCount` and refreshes `updatedAt`. The dedup merge. */
  recordRestatement(factId: number): Promise<MemoryFact | null>;

  /** Stamps `lastUsedAt`, the clock decay is measured against. */
  markUsed(factIds: number[]): Promise<void>;

  all(): Promise<MemoryFact[]>;
  delete(factIds: number[]): Promise<void>;

  /** Facts whose `lastUsedAt` (or `createdAt`, if never used) is older than `before`. */
  findUnusedSince(before: string): Promise<MemoryFact[]>;

  countFacts(): Promise<number>;

  incrementFunnel(stage: MemoryFunnelStage, by?: number): Promise<void>;
  funnel(): Promise<MemoryFunnel>;
}

export interface FactOrigin {
  runId: string;
  sessionId: string;
}

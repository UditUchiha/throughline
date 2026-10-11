import type { CorpusSource } from '../common/types/knowledge.types';

/**
 * What the scanner found when two passages cannot both be true.
 *
 * A const tuple with a guard, per §0.3 — the kind round-trips through a model
 * reply and a JSON report, so both are boundaries where a bare union would be
 * asserted rather than checked.
 */
export const CONFLICT_KINDS = ['superseded', 'unresolved'] as const;

export type ConflictKind = (typeof CONFLICT_KINDS)[number];

export function isConflictKind(value: unknown): value is ConflictKind {
  return typeof value === 'string' && (CONFLICT_KINDS as readonly string[]).includes(value);
}

/** A document as the scanner sees it: enough to judge and enough to cite. */
export interface ScannedDocument {
  chunkId: number;
  docId: string;
  source: CorpusSource | null;
  text: string;
}

/**
 * One document and the handful of documents it might disagree with.
 *
 * Neighbours are chosen by **rank, not by absolute distance**, and that was
 * measured rather than assumed. Over the 172-document corpus, a cutoff of 0.40
 * admits 421 pairs and 0.50 admits 8,143 — 55% of every possible pair — so
 * there is no threshold that separates "about the same thing" from "both in
 * English". The two known supersessions in the ledger sit at rank 1 and rank 2
 * of their document's neighbours while their absolute distances (0.3639 and
 * 0.4033) straddle the cutoff that would have to be drawn. Rank survives the
 * compression of the space; distance does not.
 */
export interface ConflictCandidate {
  subject: ScannedDocument;
  neighbours: ScannedDocument[];
}

/** One side of a conflict, carrying what it claimed and where to read it. */
export interface ConflictSide {
  docId: string;
  source: CorpusSource | null;
  /** The specific claim, quoted from the document rather than paraphrased. */
  claim: string;
}

export interface Conflict {
  kind: ConflictKind;
  /** What the two documents disagree about, as a short noun phrase. */
  topic: string;
  /**
   * For `superseded`, the claim that is no longer true. For `unresolved`,
   * simply one of two claims that cannot both hold — the ordering carries no
   * meaning there, because establishing one is precisely what failed.
   */
  outdated: ConflictSide;
  /** What replaced it, or the other irreconcilable claim. */
  current: ConflictSide;
  /** Why these cannot both be true, and what dated it — one or two sentences. */
  reasoning: string;
}

export interface ConflictReport {
  conflicts: Conflict[];
  /** Documents considered. Denominator for any rate quoted off this report. */
  documentsScanned: number;
  /** Model calls spent. One per candidate, so this is also the cost. */
  documentsJudged: number;
  /**
   * Candidates whose judgement threw. Distinct from "no conflict found": a
   * report with failures has not examined everything it counted, and a rate
   * over `documentsScanned` would quietly treat an outage as a clean bill of
   * health — the same failure the eval harness records for quota walls.
   */
  failures: number;
}

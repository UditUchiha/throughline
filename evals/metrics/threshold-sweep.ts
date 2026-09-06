/**
 * A reusable sweep for any scored cutoff.
 *
 * PLAN.md §5/M6.1 keeps this from the original harness because the project has
 * three numbers that are cutoffs over a distance and exactly one of them was ever
 * derived from measurement:
 *
 * - `RETRIEVAL_DISTANCE_THRESHOLD` — configured but **not enforced**, because the
 *   value in `env.schema.ts` was derived for `bge-m3` at 1024d and the current
 *   provider is `gemini-embedding-001` at 768d.
 * - `MEMORY_DEDUP_DISTANCE` — measured, by hand, over nine labelled pairs
 *   (`docs/memory-dedup-threshold.md`). This function is that method, written down.
 * - `MEMORY_RECALL_DISTANCE` — measured over the same nine pairs, and documented
 *   as the weaker of the two.
 *
 * The output that matters is not `best`. It is {@link SweepResult.separation}: the
 * empty band between the largest positive and the smallest negative. A cutoff
 * chosen inside a wide empty band is robust; one chosen where the two classes
 * overlap is a guess dressed as a measurement, and reporting an F1 for it would
 * hide exactly that.
 */

/** One observation, already labelled. `label` is only ever used for reporting. */
export interface LabelledValue {
  value: number;
  positive: boolean;
  label?: string;
}

/**
 * Which side of the cutoff counts as positive.
 *
 * Distances are `lower-is-positive`: a *smaller* L2 distance means "the same
 * fact" or "a relevant chunk". Scores are the other way round. Getting this
 * backwards is the exact bug `RetrievedChunk.distance` carries a comment about,
 * so it is a required argument rather than a defaulted one.
 */
export type SweepDirection = 'lower-is-positive' | 'higher-is-positive';

export interface SweepPoint {
  threshold: number;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
}

export interface SweepResult {
  direction: SweepDirection;
  points: SweepPoint[];
  /**
   * Highest F1, ties broken towards the threshold that predicts *fewer*
   * positives.
   *
   * Ties are the normal case, not an edge one: candidates are midpoints between
   * adjacent observations, so every cutoff inside a separation band scores
   * identically and one of them has to be picked. Fewer-positives is the
   * conservative direction for both cutoffs this sweep is used on — merging two
   * distinct memory facts is irrecoverable, and admitting a distant chunk as
   * evidence is a wrong citation. Stated as a property of the classification
   * rather than as "the lowest candidate", which means the opposite thing
   * depending on the direction.
   */
  best: SweepPoint | null;
  /**
   * The gap between the classes, when they do not overlap at all.
   *
   * `null` means some positive sits on the wrong side of some negative, and no
   * cutoff separates them cleanly. That is a finding, not a failure of the sweep.
   */
  separation: { low: number; high: number; width: number; midpoint: number } | null;
  counts: { positives: number; negatives: number };
}

function classify(value: number, threshold: number, direction: SweepDirection): boolean {
  return direction === 'lower-is-positive' ? value <= threshold : value >= threshold;
}

/**
 * Candidate cutoffs: the midpoint between every pair of adjacent observed values,
 * plus one outside each end.
 *
 * Midpoints rather than the observed values themselves because a cutoff sitting
 * exactly on an observation is decided by whether the comparison is `<=` or `<`,
 * which is an implementation detail rather than a property of the data.
 */
function candidateThresholds(values: number[]): number[] {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (sorted.length === 0) return [];

  const spread = sorted[sorted.length - 1] - sorted[0] || 1;
  const margin = spread * 0.05;
  const candidates = [sorted[0] - margin];

  for (let i = 1; i < sorted.length; i++) {
    candidates.push((sorted[i - 1] + sorted[i]) / 2);
  }
  candidates.push(sorted[sorted.length - 1] + margin);

  return candidates;
}

export function sweepThreshold(
  observations: LabelledValue[],
  direction: SweepDirection,
): SweepResult {
  const positives = observations.filter((o) => o.positive);
  const negatives = observations.filter((o) => !o.positive);

  const points: SweepPoint[] = candidateThresholds(observations.map((o) => o.value)).map(
    (threshold) => {
      let truePositives = 0;
      let falsePositives = 0;
      let trueNegatives = 0;
      let falseNegatives = 0;

      for (const observation of observations) {
        const predicted = classify(observation.value, threshold, direction);
        if (predicted && observation.positive) truePositives++;
        else if (predicted && !observation.positive) falsePositives++;
        else if (!predicted && observation.positive) falseNegatives++;
        else trueNegatives++;
      }

      const precision =
        truePositives + falsePositives === 0 ? 0 : truePositives / (truePositives + falsePositives);
      const recall =
        truePositives + falseNegatives === 0 ? 0 : truePositives / (truePositives + falseNegatives);

      return {
        threshold,
        truePositives,
        falsePositives,
        trueNegatives,
        falseNegatives,
        precision,
        recall,
        f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
        accuracy:
          observations.length === 0 ? 0 : (truePositives + trueNegatives) / observations.length,
      };
    },
  );

  const predictedPositives = (point: SweepPoint): number =>
    point.truePositives + point.falsePositives;

  const best = points.reduce<SweepPoint | null>((winner, point) => {
    if (winner === null || point.f1 > winner.f1) return point;
    if (point.f1 < winner.f1) return winner;
    return predictedPositives(point) < predictedPositives(winner) ? point : winner;
  }, null);

  return {
    direction,
    points,
    best,
    separation: separationBand(positives, negatives, direction),
    counts: { positives: positives.length, negatives: negatives.length },
  };
}

/**
 * The empty band between the two classes, if there is one.
 *
 * This is the whole methodology of `docs/memory-dedup-threshold.md` in four
 * lines: restatements landed at 0.087–0.276, distinct facts at 0.405+, and 0.35
 * was chosen because nothing fell in between. A band with width 0 or a null
 * result says the same measurement cannot be made for this cutoff.
 */
function separationBand(
  positives: LabelledValue[],
  negatives: LabelledValue[],
  direction: SweepDirection,
): SweepResult['separation'] {
  if (positives.length === 0 || negatives.length === 0) return null;

  const positiveEdge =
    direction === 'lower-is-positive'
      ? Math.max(...positives.map((o) => o.value))
      : Math.min(...positives.map((o) => o.value));
  const negativeEdge =
    direction === 'lower-is-positive'
      ? Math.min(...negatives.map((o) => o.value))
      : Math.max(...negatives.map((o) => o.value));

  const low = Math.min(positiveEdge, negativeEdge);
  const high = Math.max(positiveEdge, negativeEdge);

  const separated =
    direction === 'lower-is-positive' ? positiveEdge < negativeEdge : positiveEdge > negativeEdge;
  if (!separated) return null;

  return { low, high, width: high - low, midpoint: (low + high) / 2 };
}

import type { SuiteMetrics } from '../types';

/**
 * When a suite's numbers stop describing the system and start describing an outage.
 *
 * Shared by the two places that must not compare an unusable run: `renderTable`,
 * which refuses to draw a delta, and `compare.ts`, which refuses to gate. It
 * lived only in the first of those, which meant the display was honest about a
 * measurement the gate would happily pass — the worse half of the pair to protect,
 * since one is read by a person and the other decides whether a PR merges.
 */

/**
 * How much of a run may have failed before its numbers stop being comparable.
 *
 * Not zero: one question dying to a transient 5xx in a 59-question pass is noise,
 * and refusing the whole comparison over it would make the delta unreportable in
 * practice. A tenth is the point at which "some runs failed" becomes "this is a
 * measurement of an outage".
 */
export const MAX_FAILURE_RATE_FOR_COMPARISON = 0.1;

type FailureCounts = Pick<SuiteMetrics, 'questions' | 'failed'>;

export function failureRate(metrics: FailureCounts): number {
  return metrics.questions === 0 ? 0 : metrics.failed / metrics.questions;
}

/**
 * Whether this run failed too much to be compared against anything.
 *
 * A failed run scores zero rather than being dropped, which is the right choice
 * for a single question and a disastrous one in aggregate: a pass where the
 * provider answered `rate limit reached` for 56 of 59 produces a suite of the
 * correct *shape* whose rates are all floor. Worse, the metrics that carry hard
 * floors survive it — `citationValidity` and `injectionResistance` are computed
 * over the runs that returned, and an answer with no citations is vacuously
 * valid, so both read 1.0 over the three that worked. The committed
 * `single-shot` mode in `results-latest.json` is exactly that, and it is what
 * this predicate exists to catch.
 */
export function tooManyFailures(metrics: FailureCounts): boolean {
  return metrics.questions > 0 && failureRate(metrics) > MAX_FAILURE_RATE_FOR_COMPARISON;
}

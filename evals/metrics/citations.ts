import type { EvalRun, QuestionResult } from '../types';

const MARKER_PATTERN = /\[(\d+)\]/g;

/**
 * Citation validity, deterministically (PLAN.md §7).
 *
 * Two distinct failures, and they are not the same bug:
 *
 * - **An unresolved marker.** The answer text contains `[7]` but the run reports
 *   no citation numbered 7. `synthesize` already strips these before the answer
 *   leaves the graph, so a non-empty list here means that stripping regressed —
 *   which is exactly why it is checked from the outside rather than trusted.
 * - **A dangling citation.** A citation resolves to an `evidenceId` that is not
 *   in the run's evidence at all. That would mean the marker→evidence ordering
 *   and the evidence set had drifted apart, and it is the failure that would send
 *   every chip in the UI to the wrong card while looking perfectly healthy.
 *
 * An answer with no markers is vacuously valid. That is correct — abstention is a
 * scored outcome, not a citation failure — but it does mean this number alone
 * would rise as the agent gets *less* useful, so the suite reports the count of
 * answers that carried a citation at all beside it.
 */
export function scoreCitations(run: EvalRun): QuestionResult['citations'] {
  const markersInText = [
    ...new Set([...run.answerText.matchAll(MARKER_PATTERN)].map((match) => Number(match[1]))),
  ].sort((a, b) => a - b);

  const citedMarkers = new Set(run.citations.map((citation) => citation.marker));
  const unresolvedMarkers = markersInText.filter((marker) => !citedMarkers.has(marker));

  const evidenceIds = new Set(run.evidence.map((e) => e.evidenceId));
  const danglingEvidenceIds = [
    ...new Set(
      run.citations
        .map((citation) => citation.evidenceId)
        .filter((evidenceId) => !evidenceIds.has(evidenceId)),
    ),
  ];

  return {
    markersInText,
    resolved: run.citations.length,
    unresolvedMarkers,
    danglingEvidenceIds,
    valid: unresolvedMarkers.length === 0 && danglingEvidenceIds.length === 0,
  };
}

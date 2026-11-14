import type { QuestionResult, SuiteMetrics } from '../types';

/** Mean of the defined values, or null when nothing contributed one. */
function meanOf(values: (number | null)[]): number | null {
  const defined = values.filter((value): value is number => value !== null);
  if (defined.length === 0) return null;
  return defined.reduce((sum, value) => sum + value, 0) / defined.length;
}

function fractionOf(results: QuestionResult[], predicate: (r: QuestionResult) => boolean): number {
  if (results.length === 0) return 0;
  return results.filter(predicate).length / results.length;
}

/**
 * Rolls per-question results into the table `pnpm eval` prints.
 *
 * Two rules run through all of it, and both exist so a number cannot flatter the
 * system by accident:
 *
 * - **A failed run scores zero, it is never dropped.** A crash that removed a
 *   question from the denominator would make an unstable agent look like an
 *   accurate one.
 * - **A metric that does not apply is `null`, never 1.** Recall over the
 *   unanswerable set, source coverage where no source is required, judged
 *   correctness with no judge — each of those would otherwise contribute a
 *   perfect score for something nobody measured.
 */
export function aggregate(results: QuestionResult[]): SuiteMetrics {
  const judged = results.filter((r) => r.judge !== null);
  // The unanswerable set is scored whether or not a judge saw it, and from the
  // run's own `abstained` flag. Leaving it to the judge's `abstention` field let
  // an answered unanswerable question drop out of the denominator whenever the
  // judge filled in `not_applicable` instead of `wrongly_answered` — observed on
  // `q.acme-corp-contract`, which left the agent's 100% resting on one question.
  // Answerable questions still need the judge, to tell a wrong refusal apart.
  const abstentionScored = results.filter(
    (r) =>
      r.question.expectedAbstention ||
      (r.judge !== null && r.judge.abstention !== 'not_applicable'),
  );
  const supportJudged = judged.filter((r) => r.judge!.citationSupport !== 'not_applicable');
  const exercisedInjection = results.filter((r) => r.injection.exercised);

  const guardrailPassRate: Record<string, number> = {};
  const guardrailNames = [...new Set(results.flatMap((r) => r.run.guardrails.map((g) => g.name)))];
  for (const name of guardrailNames) {
    const scored = results.flatMap((r) => r.run.guardrails.filter((g) => g.name === name));
    guardrailPassRate[name] =
      scored.length === 0 ? 0 : scored.filter((g) => g.passed).length / scored.length;
  }

  const memory = results.reduce(
    (totals, r) => ({
      runsSkippedByGate:
        totals.runsSkippedByGate + (r.run.memory.skippedNoSelfReference > 0 ? 1 : 0),
      runsProposingACandidate: totals.runsProposingACandidate + (r.run.memory.proposed > 0 ? 1 : 0),
      proposed: totals.proposed + r.run.memory.proposed,
      droppedLowImportance: totals.droppedLowImportance + r.run.memory.droppedLowImportance,
      mergedDuplicate: totals.mergedDuplicate + r.run.memory.mergedDuplicate,
      stored: totals.stored + r.run.memory.stored,
      runsWithRecall: totals.runsWithRecall + (r.run.memory.recalledFacts > 0 ? 1 : 0),
    }),
    {
      runsSkippedByGate: 0,
      runsProposingACandidate: 0,
      proposed: 0,
      droppedLowImportance: 0,
      mergedDuplicate: 0,
      stored: 0,
      runsWithRecall: 0,
    },
  );

  // Cost is null-propagating for the same reason `UsageService.costOf` is: a total
  // that silently omits an unpriced call reads as authoritative while being wrong.
  const costs = results.map((r) => r.run.costUsd);
  const totalCostUsd = costs.some((cost) => cost === null)
    ? null
    : costs.reduce((sum: number, cost) => sum + (cost ?? 0), 0);

  return {
    questions: results.length,
    failed: results.filter((r) => r.run.error !== null).length,
    judgeUnavailable: results.length - judged.length,
    recallAtK: meanOf(results.map((r) => r.recall.value)),
    citationValidity: fractionOf(results, (r) => r.citations.valid),
    answeredRuns: results.filter((r) => !r.run.abstained).length,
    citedAnswers: results.filter((r) => r.run.citations.length > 0).length,
    answerCorrectness:
      judged.length === 0 ? null : fractionOf(judged, (r) => r.judge!.correctness === 'correct'),
    partialCorrectness:
      judged.length === 0 ? null : fractionOf(judged, (r) => r.judge!.correctness !== 'incorrect'),
    citationSupport:
      supportJudged.length === 0
        ? null
        : fractionOf(supportJudged, (r) => r.judge!.citationSupport === 'supported'),
    abstentionCorrectness:
      abstentionScored.length === 0
        ? null
        : fractionOf(abstentionScored, (r) =>
            r.question.expectedAbstention
              ? r.run.abstained
              : r.judge!.abstention === 'correctly_refused',
          ),
    injectionResistance:
      exercisedInjection.length === 0
        ? null
        : fractionOf(exercisedInjection, (r) => r.injection.resisted),
    injectionExercised: exercisedInjection.length,
    planSourceCoverage: meanOf(results.map((r) => r.plan.sourceCoverage)),
    meetsMinHops: fractionOf(results, (r) => r.plan.meetsMinHops),
    meanHops: meanOf(results.map((r) => r.plan.hopsUsed)) ?? 0,
    meanSubQuestions: meanOf(results.map((r) => r.plan.subQuestionCount)) ?? 0,
    meanLatencyMs: meanOf(results.map((r) => r.run.latencyMs)) ?? 0,
    totalCostUsd,
    totalInputTokens: results.reduce((sum, r) => sum + r.run.usage.inputTokens, 0),
    totalOutputTokens: results.reduce((sum, r) => sum + r.run.usage.outputTokens, 0),
    guardrailPassRate,
    memory: {
      ...memory,
      retentionRate: memory.proposed === 0 ? null : memory.stored / memory.proposed,
    },
  };
}

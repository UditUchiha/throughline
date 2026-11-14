import type { CorpusSource } from '../../src/common/types/knowledge.types';
import type { EvalQuestion, EvalRun, QuestionResult } from '../types';

/**
 * Planner quality in isolation (PLAN.md §7).
 *
 * Source coverage is measured against the *retrieved evidence*, not against the
 * tools the plan named. A plan that assigns `mail_search` and gets nothing back
 * has not covered `mail`, and the thing the question asserts is that a correct
 * answer draws on those sources — so the evidence is the honest place to look.
 *
 * `meetsMinHops` is a floor, not a target. `minHops` is the number of extra
 * retrieval rounds a question is expected to *need*; running more is a cost
 * problem the hop and latency numbers already price, not a correctness one.
 */
export function scorePlan(run: EvalRun, question: EvalQuestion): QuestionResult['plan'] {
  const retrievedSources = new Set<CorpusSource>(
    run.evidence.map((e) => e.source).filter((source): source is CorpusSource => source !== null),
  );

  const missingSources = question.requiredSources.filter((source) => !retrievedSources.has(source));

  return {
    subQuestionCount: run.subQuestions.length,
    hopsUsed: run.hops,
    meetsMinHops: run.hops >= question.minHops,
    // Null when the question requires no particular source — the unanswerable
    // set — for the same reason recall is null there: a vacuous 1.0 across eight
    // questions would quietly lift the headline number.
    sourceCoverage:
      question.requiredSources.length === 0
        ? null
        : (question.requiredSources.length - missingSources.length) /
          question.requiredSources.length,
    missingSources,
  };
}

/**
 * Retrieval rounds a run made beyond its first — what `EvalRun.hops` and
 * `minHops` both mean.
 *
 * Not `state.hops`, which counts `reflect` passes: every agent run reflects at
 * least once, including the pass that finds no gap, so it is the round count
 * plus one. Recording it directly made every agent run clear `minHops: 1` and
 * the single-shot control — which never reflects — score exactly its
 * `minHops: 0` share, so the comparison measured the graph's shape rather than
 * the agent's behaviour. A follow-up carries the hop it was issued in, so the
 * deepest one is the number of rounds that actually ran.
 */
export function extraRetrievalRounds(subQuestions: { hop: number }[]): number {
  return Math.max(0, ...subQuestions.map((sq) => sq.hop));
}

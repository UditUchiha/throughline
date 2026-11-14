import type { EvalQuestion, EvalRun, QuestionResult } from '../types';

/**
 * Recall@k against the documents the answer key says express the required facts
 * (PLAN.md §7).
 *
 * This is the one retrieval metric that is completely free of the generator: a
 * fact names its `expressedIn` documents, a retrieved chunk carries the `docId`
 * from its frontmatter, and the score is set membership. No embedding, no
 * threshold, no judge.
 *
 * `k` is not a parameter here on purpose. What was retrieved is whatever the run
 * actually retrieved — `TOP_K` per tool call, times however many calls the plan
 * made, deduplicated. Pinning a nominal k would measure a number the run never
 * used. Note this is everything in state, *before* `synthesize` keeps the closest
 * 12: a document retrieved but cut from the prompt still counts as recalled.
 */
export function scoreRecall(run: EvalRun, question: EvalQuestion): QuestionResult['recall'] {
  const expected = [...question.expectedDocIds];
  const retrieved = [
    ...new Set(run.evidence.map((e) => e.docId).filter((id): id is string => id !== null)),
  ];
  const retrievedSet = new Set(retrieved);
  const hits = expected.filter((docId) => retrievedSet.has(docId));

  return {
    expected,
    retrieved,
    hits,
    // Null rather than 1 when nothing is expected. The unanswerable set has no
    // supporting documents by construction, and scoring it as perfect recall
    // would let eight questions inflate the headline retrieval number while
    // measuring nothing at all.
    value: expected.length === 0 ? null : hits.length / expected.length,
  };
}

import { z } from 'zod';
import { CORPUS_SOURCES, type CorpusSource } from '../../common/types/knowledge.types';

/**
 * The question categories authored in `corpus/questions.yaml` (PLAN.md §6).
 *
 * The UI labels chips by category — "needs 2 sources", "a fact that changed",
 * "should refuse to answer" — so the category is the one ledger field that has to
 * survive the projection below.
 */
export const questionCategories = [
  'single-hop',
  'multi-hop',
  'temporal',
  'distractor',
  'unanswerable',
  // M5. A question whose supporting document also carries a prompt-injection
  // payload: correct behaviour is to answer the question asked and ignore the
  // instruction embedded in the evidence. Scored in M6.
  'adversarial',
] as const;

export type QuestionCategory = (typeof questionCategories)[number];

/**
 * What a caller of `GET /agent/examples` receives.
 *
 * Deliberately a *subset* of the ledger entry. `referenceAnswer` and
 * `requiredFacts` are the answer key: serving them over HTTP would let the graded
 * answer reach a prompt by accident, which is exactly the circularity the
 * authored-first corpus exists to avoid (PLAN.md §6).
 */
export interface ExampleQuestion {
  id: string;
  question: string;
  category: QuestionCategory;
  /** Source types a correct answer must draw from — rendered as badges. */
  requiredSources: CorpusSource[];
  /** Retrieval rounds expected *beyond* the first. 0 = one round. */
  minHops: number;
  /** True when refusing is the correct behaviour. */
  expectedAbstention: boolean;
  /** Slug of a recorded run for this question, when one exists. Enables `?demo=1`. */
  demoSlug?: string;
}

/**
 * Parses only the fields that are served. Unknown keys are ignored rather than
 * rejected so that adding a field to the ledger — which `/add-fact` does — never
 * breaks this endpoint.
 */
export const ledgerQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  category: z.enum(questionCategories),
  requiredSources: z.array(z.enum(CORPUS_SOURCES)).default([]),
  minHops: z.coerce.number().int().nonnegative().default(0),
  expectedAbstention: z.boolean().default(false),
});

/**
 * The file's shape only. Rows stay `unknown` on purpose: validating them here as
 * `z.array(ledgerQuestionSchema)` makes one bad question fail the whole parse,
 * and the service would then serve nothing at all. `ExampleQuestionsService`
 * applies {@link ledgerQuestionSchema} per row and skips what does not fit.
 */
export const questionsFileSchema = z.object({
  questions: z.array(z.unknown()).default([]),
});

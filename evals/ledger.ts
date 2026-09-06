import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSON_SCHEMA, load as parseYaml } from 'js-yaml';
import { z } from 'zod';
import { questionCategories } from '../src/agent/examples/example-question';
import type { CorpusSource } from '../src/common/types/knowledge.types';
import type { EvalQuestion } from './types';

/**
 * Reads the answer key.
 *
 * This is the half of the eval suite that must not be generated, guessed at, or
 * derived from anything a model wrote: `facts.yaml` is hand-authored ground
 * truth, `documents.yaml` says which documents express each fact, and
 * `questions.yaml` derives questions from fact ids (PLAN.md §6). Resolving the
 * three here is what turns recall@k into a set-membership test instead of an
 * LLM judgment.
 *
 * Validation is strict and fails the whole load. That is the opposite of
 * `ExampleQuestionsService`, which skips a malformed row so the UI keeps working
 * — and deliberately so: a question the UI cannot render costs a visitor one
 * chip, but a question the harness silently drops changes the denominator of
 * every number in the results table.
 */

const factSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  expressedIn: z.array(z.string().min(1)).default([]),
  supersedes: z.string().nullable().default(null),
});

/**
 * Only the fields the harness needs. `.passthrough()` is deliberate — mail, chat
 * and notes documents have different shapes, and re-declaring all three here
 * would mean `/add-fact` adding a field could fail the eval load for no reason.
 */
const documentSchema = z
  .object({
    docId: z.string().min(1),
    factIds: z.array(z.string()).default([]),
    /** Set on documents carrying an attacker-authored payload (M5). */
    adversarial: z.boolean().default(false),
  })
  .loose();

const documentsFileSchema = z.object({
  mail: z.array(documentSchema).default([]),
  chat: z.array(documentSchema).default([]),
  notes: z.array(documentSchema).default([]),
});

const questionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  category: z.enum(questionCategories),
  requiredFacts: z.array(z.string()).default([]),
  requiredSources: z.array(z.enum(['mail', 'chat', 'notes'])).default([]),
  minHops: z.coerce.number().int().nonnegative().default(0),
  expectedAbstention: z.boolean().default(false),
  referenceAnswer: z.string().min(1),
});

export interface EvalLedger {
  questions: EvalQuestion[];
  /** docId → source, for turning `expressedIn` into a source expectation. */
  sourceByDocId: Map<string, CorpusSource>;
  /** Documents whose body is an attacker-authored payload. */
  adversarialDocIds: Set<string>;
}

function readYaml<T>(path: string, schema: z.ZodType<T>, label: string): T {
  const raw: unknown = parseYaml(readFileSync(path, 'utf8'), { schema: JSON_SCHEMA });
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`${label} (${path}) is not valid:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/**
 * Loads and cross-resolves the ledger.
 *
 * Every dangling reference is an error rather than a warning. A question naming a
 * fact that no longer exists would otherwise score a recall of 0/0 — reported as
 * "no expected documents", which reads as a pass.
 */
export function loadEvalLedger(corpusDir: string): EvalLedger {
  const facts = readYaml(
    join(corpusDir, 'ledger', 'facts.yaml'),
    z.object({ facts: z.array(factSchema) }),
    'facts.yaml',
  ).facts;

  const documents = readYaml(
    join(corpusDir, 'ledger', 'documents.yaml'),
    documentsFileSchema,
    'documents.yaml',
  );

  const questions = readYaml(
    join(corpusDir, 'questions.yaml'),
    z.object({ questions: z.array(questionSchema) }),
    'questions.yaml',
  ).questions;

  const sourceByDocId = new Map<string, CorpusSource>();
  const adversarialDocIds = new Set<string>();
  for (const [source, docs] of Object.entries(documents) as [
    CorpusSource,
    typeof documents.mail,
  ][]) {
    for (const doc of docs) {
      sourceByDocId.set(doc.docId, source);
      if (doc.adversarial) adversarialDocIds.add(doc.docId);
    }
  }

  const factById = new Map(facts.map((fact) => [fact.id, fact]));
  const problems: string[] = [];

  for (const fact of facts) {
    for (const docId of fact.expressedIn) {
      if (!sourceByDocId.has(docId)) {
        problems.push(`facts.yaml: ${fact.id} expressedIn "${docId}" — no such document`);
      }
    }
  }

  const resolved: EvalQuestion[] = questions.map((row) => {
    const expectedDocIds = new Set<string>();
    const statements: string[] = [];
    let adversarial = false;

    for (const factId of row.requiredFacts) {
      const fact = factById.get(factId);
      if (!fact) {
        problems.push(`questions.yaml: ${row.id} requires "${factId}" — no such fact`);
        continue;
      }
      statements.push(fact.statement.trim());
      for (const docId of fact.expressedIn) {
        expectedDocIds.add(docId);
        if (adversarialDocIds.has(docId)) adversarial = true;
      }
    }

    return {
      id: row.id,
      question: row.question,
      category: row.category,
      requiredFacts: row.requiredFacts,
      requiredSources: row.requiredSources,
      minHops: row.minHops,
      expectedAbstention: row.expectedAbstention,
      referenceAnswer: row.referenceAnswer.trim(),
      expectedDocIds: [...expectedDocIds],
      requiredFactStatements: statements,
      adversarial,
    };
  });

  const ids = new Set<string>();
  for (const question of resolved) {
    if (ids.has(question.id))
      problems.push(`questions.yaml: duplicate question id "${question.id}"`);
    ids.add(question.id);
  }

  if (problems.length > 0) {
    throw new Error(`The answer key does not resolve:\n  - ${problems.join('\n  - ')}`);
  }

  return { questions: resolved, sourceByDocId, adversarialDocIds };
}

/**
 * The subset a pull request runs.
 *
 * PLAN.md §5/M6.3 requires this to fit inside a free provider's limits, which is
 * a hard number rather than a preference: one agent run costs ~5 model calls and
 * Gemini's free tier allows ~20 per window, so a subset is bounded at roughly
 * "how long is a CI job allowed to take". Nine questions is ~45 calls for the
 * agent — a few minutes with the `gemini → groq` failover absorbing the stalls.
 *
 * Chosen for coverage rather than difficulty: every category appears, including
 * the two that only exist to be scored (unanswerable, adversarial), plus the
 * one multi-hop question observed to trigger a real second hop.
 */
export const PR_SUBSET_QUESTION_IDS = [
  'q.tariq-start-date',
  'q.helios-full-story',
  'q.board-full-outcomes',
  'q.current-pricing-model',
  'q.security-vulnerability-disambiguation',
  'q.head-of-hr',
  'q.acme-corp-contract',
  'q.injection-vendor-email',
  'q.assistant-injection-policy',
];

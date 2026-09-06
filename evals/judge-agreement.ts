/**
 * Measures the LLM judge against hand labels (PLAN.md §7).
 *
 *   pnpm eval:judge-agreement [--limit=<n>] [--labels=<path>]
 *
 * "An unvalidated LLM judge is not a measurement." This is the validation: 20
 * hand-authored items in `evals/judge-labels.json`, run through the same
 * {@link JudgeClient} the suite uses, reported as per-dimension agreement and a
 * confusion matrix on correctness.
 *
 * One model call per item, so 20 calls. Cheap enough to re-run whenever the judge
 * prompt, the judge model or the provider chain changes — which is exactly when
 * an agreement number stops being valid.
 *
 * The limitation of the label set is stated in the file itself and it is real:
 * the answers are authored rather than sampled, so agreement here is an
 * optimistic bound. Report it as such.
 */

import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { flagInt, flagValue } from './harness/flags';
import { emptyMemoryActivity } from './types';
import { dirname, join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { loadMarkdownArticles } from '../src/knowledge/markdown-loader';
import { JudgeClient } from './harness/judge';
import { loadEvalLedger } from './ledger';
import type { EvalRun, EvidenceRecord, JudgeVerdict } from './types';

interface LabelItem {
  id: string;
  questionId: string;
  answer: string;
  citedDocIds: string[];
  abstained: boolean;
  expected: {
    correctness: JudgeVerdict['correctness'];
    citationSupport: JudgeVerdict['citationSupport'];
    abstention: JudgeVerdict['abstention'];
  };
}

interface LabelFile {
  schemaVersion: 1;
  items: LabelItem[];
}

/**
 * Per-item verdict cache, for the same reason the eval harness has one.
 *
 * 20 judge calls sounds small enough not to need this. It is not: on a free tier
 * that had already served a 59-question pass, Groq allowed roughly *one* call per
 * window, so an uncached run scored item 1 and stopped. Caching each verdict means
 * repeated invocations accumulate instead of restarting, and the run completes
 * over however many windows it takes.
 *
 * Keyed by the judge model and by the label's own content, so changing either the
 * judge or a label invalidates only what it should. Verdicts are only ever written
 * after a successful call, so a failure is never persisted.
 */
function verdictCachePath(item: LabelItem, judgeModel: string): string {
  const key = createHash('sha1')
    .update(JSON.stringify({ judgeModel, item }))
    .digest('hex')
    .slice(0, 16);
  return join('./evals/.cache/judge-agreement', `${item.id}.${key}.json`);
}

function readCachedVerdict(item: LabelItem, judgeModel: string): JudgeVerdict | null {
  const path = verdictCachePath(item, judgeModel);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as JudgeVerdict;
  } catch {
    return null;
  }
}

function writeCachedVerdict(item: LabelItem, judgeModel: string, verdict: JudgeVerdict): void {
  const path = verdictCachePath(item, judgeModel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(verdict, null, 2)}\n`);
}

/**
 * Builds the run the judge sees, with real passage text from the corpus on disk.
 *
 * Deliberately not from the index: a label must be checkable by reading a file,
 * and going through the database would make the label set depend on which
 * embedding model built it.
 */
function synthesiseRun(item: LabelItem, textByDocId: Map<string, string>): EvalRun {
  const evidence: EvidenceRecord[] = item.citedDocIds.map((docId, index) => {
    const text = textByDocId.get(docId);
    if (text === undefined) throw new Error(`Label "${item.id}" cites unknown document "${docId}"`);
    return {
      evidenceId: `ev-label-${index + 1}`,
      docId,
      source: null,
      title: docId,
      distance: 0.45,
      tool: 'all_sources_search',
      text,
    };
  });

  return {
    questionId: item.questionId,
    mode: 'agent',
    question: item.id,
    runId: `label-${item.id}`,
    answerText: item.answer,
    abstained: item.abstained,
    citations: evidence.map((e, index) => ({ marker: index + 1, evidenceId: e.evidenceId })),
    evidence,
    subQuestions: [],
    hops: 0,
    toolsUsed: [],
    unknownToolCalls: [],
    latencyMs: 0,
    costUsd: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    models: [],
    memory: emptyMemoryActivity(),
    guardrails: [],
    error: null,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const labelsPath = flagValue(argv, '--labels', './evals/judge-labels.json');
  const limit = flagInt(argv, '--limit', 0);

  if (!existsSync(labelsPath)) throw new Error(`No label set at ${labelsPath}`);
  const labels = JSON.parse(readFileSync(labelsPath, 'utf8')) as LabelFile;
  const items = limit > 0 ? labels.items.slice(0, limit) : labels.items;

  const ledger = loadEvalLedger('./corpus');
  const questionById = new Map(ledger.questions.map((question) => [question.id, question]));

  const textByDocId = new Map<string, string>();
  for (const article of loadMarkdownArticles('./corpus/generated')) {
    if (article.docId) textByDocId.set(article.docId, article.content.trim());
  }

  // No connectors and no tracing: this exercises the judge, not the pipeline.
  process.env.DEMO_MODE = 'false';
  process.env.MCP_SERVERS = '[]';
  process.env.LANGSMITH_TRACING = 'false';

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });

  try {
    const judge = JudgeClient.create(app);
    console.log(`\njudge agreement — ${judge.model}, ${items.length} hand-labelled item(s)`);
    if (!judge.separateProvider) {
      console.log('  ⚠ same provider and model as the answerer — not an independent judge');
    }
    console.log('');

    const agreement = { correctness: 0, citationSupport: 0, abstention: 0 };
    const confusion = new Map<string, number>();
    const disagreements: string[] = [];
    const failedItems: string[] = [];
    let scored = 0;
    let attempted = 0;

    for (const item of items) {
      attempted++;
      const question = questionById.get(item.questionId);
      if (!question)
        throw new Error(`Label "${item.id}" names unknown question "${item.questionId}"`);

      // One judge call failing must not throw away the items already scored. The
      // first attempt at this hit a provider rate limit on item 2 of 20 and lost
      // item 1 with it — the same lesson the harness cache learned, in a script
      // small enough that it looked like it did not need it. A partial agreement
      // figure over a stated denominator is useful; nothing is not.
      const cached = readCachedVerdict(item, judge.model);
      let verdict: JudgeVerdict;
      try {
        verdict = cached ?? (await judge.judge(question, synthesiseRun(item, textByDocId)));
        if (!cached) writeCachedVerdict(item, judge.model, verdict);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`  !!   ${item.id.padEnd(32)} judge failed: ${message.split('\n')[0]}`);
        failedItems.push(item.id);
        // A rate limit will hit every remaining item too, so stop rather than
        // printing eighteen identical failures and calling it a run.
        if (/rate limit|quota/i.test(message)) {
          console.log('\n  Stopping: the judge provider is rate limited.');
          break;
        }
        continue;
      }

      scored++;
      const correct = verdict.correctness === item.expected.correctness;
      const support = verdict.citationSupport === item.expected.citationSupport;
      const abstain = verdict.abstention === item.expected.abstention;

      if (correct) agreement.correctness++;
      if (support) agreement.citationSupport++;
      if (abstain) agreement.abstention++;

      const cell = `${item.expected.correctness} → ${verdict.correctness}`;
      confusion.set(cell, (confusion.get(cell) ?? 0) + 1);

      console.log(
        `  ${correct ? 'ok  ' : 'DIFF'} ${item.id.padEnd(32)} ` +
          `correctness ${verdict.correctness.padEnd(9)} ` +
          `support ${verdict.citationSupport.padEnd(15)} ` +
          `abstention ${verdict.abstention}` +
          (cached ? '  (cached)' : ''),
      );

      if (!correct || !support || !abstain) {
        disagreements.push(
          `  ${item.id}\n` +
            `    expected  ${item.expected.correctness} / ${item.expected.citationSupport} / ${item.expected.abstention}\n` +
            `    judge     ${verdict.correctness} / ${verdict.citationSupport} / ${verdict.abstention}\n` +
            `    reason    ${verdict.reasoning}`,
        );
      }
    }

    // The denominator is what was actually scored — never `items.length`, and
    // never "items minus the ones that errored", which would silently count the
    // ones a rate-limit `break` never reached as agreements of zero.
    const n = scored;
    const notReached = items.length - attempted;

    if (n < items.length) {
      const parts = [
        failedItems.length > 0 ? `${failedItems.length} failed (${failedItems.join(', ')})` : '',
        notReached > 0 ? `${notReached} never attempted` : '',
      ].filter(Boolean);
      console.log(
        `\n  ⚠ ${items.length - n} of ${items.length} item(s) were not scored: ` +
          `${parts.join(', ')}.\n` +
          `  Every figure below is over the ${n} that were. Re-run to fill them in.`,
      );
    }

    if (n === 0) {
      console.log('\n  Nothing was scored, so there is no agreement figure to report.\n');
      return;
    }

    console.log('\n  agreement with hand labels');
    console.log(
      `    correctness      ${agreement.correctness}/${n}  ${rate(agreement.correctness, n)}`,
    );
    console.log(
      `    citation support ${agreement.citationSupport}/${n}  ${rate(agreement.citationSupport, n)}`,
    );
    console.log(
      `    abstention       ${agreement.abstention}/${n}  ${rate(agreement.abstention, n)}`,
    );

    console.log('\n  correctness confusion (expected → judged)');
    for (const [cell, count] of [...confusion.entries()].sort()) {
      console.log(`    ${cell.padEnd(28)} ${count}`);
    }

    if (disagreements.length > 0) {
      console.log(`\n  ${disagreements.length} item(s) the judge saw differently:\n`);
      console.log(disagreements.join('\n\n'));
    }

    console.log(
      '\n  Note: these answers are authored, not sampled from real runs, so this is an\n' +
        '  optimistic bound on agreement over the distribution the suite actually judges.\n',
    );
  } finally {
    await app.close();
  }
}

function rate(hits: number, total: number): string {
  return total === 0 ? '—' : `${((hits / total) * 100).toFixed(0)}%`;
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

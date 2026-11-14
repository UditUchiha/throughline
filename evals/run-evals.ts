/**
 * The eval harness (PLAN.md §5/M6.1).
 *
 *   pnpm eval                          the agent over all 59 questions
 *   pnpm eval --baseline=single-shot   the non-agentic control
 *   pnpm eval --subset=pr              the nine-question CI subset
 *   pnpm eval --no-judge               deterministic metrics only, zero model calls
 *
 * ⚠️ **Quota is the binding constraint, not a footnote.** 59 questions × ~5 model
 * calls is ~295 for one agent pass, plus 59 judge calls; the baseline adds ~118.
 * A full comparison is roughly 470 calls against a Gemini free tier of ~20 per
 * window. Everything in `evals/harness/cli.ts` exists to make that survivable:
 * results are cached per question so a killed run resumes, and every filter
 * narrows real work. A full run needs a billed key or several hours.
 *
 * See `evals/README.md` for what each metric means and for the two decisions the
 * suite makes on your behalf (connectors off, memory reset between questions).
 */

import 'reflect-metadata';
import { PR_SUBSET_QUESTION_IDS, loadEvalLedger } from './ledger';
import { EVAL_USAGE, parseEvalArgs, type EvalOptions } from './harness/cli';
import { EvalCache, type RunFingerprint } from './harness/cache';
import { createEvalContext } from './harness/context';
import { JudgeClient } from './harness/judge';
import { MemoryProbe, runAgentQuestion } from './harness/run-agent';
import { runBaselineQuestion } from './harness/run-baseline';
import { otherMode, renderFailures, renderTable, writeResults } from './harness/report';
import { aggregate } from './metrics/aggregate';
import { scoreCitations } from './metrics/citations';
import { scoreInjection } from './metrics/injection';
import { scorePlan } from './metrics/plan-quality';
import { scoreRecall } from './metrics/recall';
import type { EvalQuestion, QuestionResult, SuiteResult } from './types';

const CORPUS_DIR = './corpus';

function selectQuestions(all: EvalQuestion[], options: EvalOptions): EvalQuestion[] {
  let selected = all;

  if (options.subset === 'pr') {
    const wanted = new Set(PR_SUBSET_QUESTION_IDS);
    selected = selected.filter((question) => wanted.has(question.id));
    const missing = PR_SUBSET_QUESTION_IDS.filter(
      (id) => !selected.some((question) => question.id === id),
    );
    // Loudly, not quietly: a CI subset that silently shrinks would keep passing
    // while covering less, which is the failure mode a gate exists to prevent.
    if (missing.length > 0) {
      throw new Error(
        `The PR subset names questions that are not in the ledger: ${missing.join(', ')}`,
      );
    }
  }

  if (options.category) {
    selected = selected.filter((question) => question.category === options.category);
    if (selected.length === 0) throw new Error(`No questions in category "${options.category}"`);
  }

  if (options.only.length > 0) {
    const wanted = new Set(options.only);
    selected = selected.filter((question) => wanted.has(question.id));
    const missing = options.only.filter((id) => !selected.some((question) => question.id === id));
    if (missing.length > 0) throw new Error(`No such question id(s): ${missing.join(', ')}`);
  }

  if (options.limit !== null) selected = selected.slice(0, options.limit);
  if (selected.length === 0) throw new Error('No questions selected.');

  return selected;
}

/**
 * Runs the selected questions with bounded concurrency, in order.
 *
 * Concurrency defaults to 1 and should usually stay there. Free-tier quota is
 * per-window, so parallelism does not buy throughput — it converts a slow
 * successful run into a fast burst of 429s, and `LLM_MAX_RETRIES` is already low
 * because retrying into a quota wall makes it worse.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(EVAL_USAGE);
    return;
  }

  const options = parseEvalArgs(argv);
  const ledger = loadEvalLedger(CORPUS_DIR);
  const questions = selectQuestions(ledger.questions, options);

  console.log(`\nthroughline evals — ${options.mode}, ${questions.length} question(s)\n`);

  const context = await createEvalContext(options);
  const startedAt = new Date().toISOString();

  try {
    const fingerprint: RunFingerprint = {
      mode: options.mode,
      answerProvider: [context.config.llmProvider, ...context.config.llmFallbackProviders].join(
        '→',
      ),
      embeddingModel: `${context.config.embeddingProvider}/${context.config.embeddingModel}@${context.config.embeddingDimensions}`,
      topK: context.config.topK,
      maxHops: context.config.maxHops,
      connectors: options.connectors,
      memory: options.memory,
      tools: context.toolNames,
      guardrails: context.guardrailNames,
      hops: 'retrieval-rounds',
    };
    const cache = new EvalCache(fingerprint, options.fresh);
    const judge = options.judge ? JudgeClient.create(context.app) : null;

    if (judge && !judge.separateProvider) {
      console.warn(
        `⚠ The judge runs on ${judge.model}, the same provider and model as the answerer. ` +
          `Configure a second provider (LLM_FALLBACK_PROVIDERS + its key) for a judge that is ` +
          `at least a different vendor. See PLAN.md §7.\n`,
      );
    }

    const memory = MemoryProbe.from(context.app, options.memory);

    if (options.concurrency > 1 && options.mode === 'agent') {
      // The funnel counters are read either side of each run, so two runs in
      // flight interleave and neither delta belongs to the run it is recorded
      // against. The suite *total* survives — the counters are cumulative, so
      // end-minus-start is still right — but "how many runs proposed a candidate
      // at all", which is the number that decides whether extraction should be
      // gated, does not.
      console.warn(
        `⚠ --concurrency=${options.concurrency}: per-run memory deltas are not attributable, ` +
          `so runsProposingACandidate is unreliable in this run. Suite totals remain correct. ` +
          `Use --concurrency=1 for the memory numbers.\n`,
      );
    }

    const results = await mapWithConcurrency(
      questions,
      options.concurrency,
      async (question, i) => {
        const position = `[${String(i + 1).padStart(2)}/${questions.length}]`;

        const cached = cache.readRun(options.mode, question.id);
        let fromCache = cached !== null;

        // The guardrail verdicts travel with the run rather than being re-derived
        // at scoring time, so a cached answer is never graded against a newer set
        // of checks than the one it was produced under.
        const run =
          cached ??
          (options.mode === 'agent'
            ? await runAgentQuestion(context.app, memory, question)
            : await runBaselineQuestion(context.app, question));
        if (!cached) cache.writeRun(run);

        let verdict = judge
          ? cache.readJudgment(options.mode, question.id, run.answerText, judge.model)
          : null;
        if (judge && !verdict) {
          try {
            verdict = await judge.judge(question, run);
            cache.writeJudgment(options.mode, question.id, run.answerText, verdict);
          } catch (error) {
            // Observed on the first full pass: one transient "Connection error"
            // from the judge provider at question 35 of 59 ended the whole suite.
            // The cached runs survived, but ~150 model calls of progress stopped
            // for a network blip — which against a free tier is most of a day.
            // Nothing is cached here on purpose, so a re-run retries the judgment
            // rather than inheriting a hole.
            console.warn(
              `  ! judge failed for ${question.id}: ` +
                `${error instanceof Error ? error.message : String(error)}`,
            );
          }
          fromCache = false;
        }

        const result: QuestionResult = {
          question,
          run,
          judge: verdict,
          recall: scoreRecall(run, question),
          citations: scoreCitations(run),
          injection: scoreInjection(run, question, ledger.adversarialDocIds),
          plan: scorePlan(run, question),
        };

        console.log(
          `${position} ${question.id.padEnd(44)} ` +
            `${run.error ? 'FAILED' : (verdict?.correctness ?? 'unjudged')}`.padEnd(11) +
            `recall ${result.recall.hits.length}/${result.recall.expected.length}  ` +
            `${run.citations.length} cite  ${Math.round(run.latencyMs)}ms` +
            (fromCache ? '  (cached)' : ''),
        );

        return result;
      },
    );

    const suite: SuiteResult = {
      config: {
        mode: options.mode,
        startedAt,
        finishedAt: new Date().toISOString(),
        questionCount: results.length,
        subset: options.subset === 'pr' ? 'pr' : describeSelection(options),
        connectors: options.connectors,
        memory: options.memory,
        answerProvider: fingerprint.answerProvider,
        judge: {
          model: judge?.model ?? null,
          separateProvider: judge?.separateProvider ?? false,
          tierSeparation: false,
        },
        embeddingModel: fingerprint.embeddingModel,
        topK: fingerprint.topK,
      },
      metrics: aggregate(results),
      results,
    };

    const merged = writeResults(options.out, suite);
    const comparison = merged.modes[otherMode(options.mode)] ?? null;

    console.log(renderTable(suite, comparison));
    console.log(renderFailures(suite));
    console.log(`  written to ${options.out}\n`);

    if (comparison === null) {
      console.log(
        `  No ${otherMode(options.mode)} results yet. Run ` +
          `\`pnpm eval ${options.mode === 'agent' ? '--baseline=single-shot' : ''}\` ` +
          `over the same questions for the headline comparison.\n`,
      );
    }
  } finally {
    await context.app.close();
  }
}

function describeSelection(options: EvalOptions): string {
  const parts: string[] = [];
  if (options.category) parts.push(`category=${options.category}`);
  if (options.only.length > 0) parts.push(`only=${options.only.join(',')}`);
  if (options.limit !== null) parts.push(`limit=${options.limit}`);
  return parts.length === 0 ? 'full' : parts.join(' ');
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

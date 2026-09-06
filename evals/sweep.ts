/**
 * Re-derives `RETRIEVAL_DISTANCE_THRESHOLD` from a finished eval run.
 *
 *   pnpm eval:sweep [--results=<path>] [--mode=agent]
 *
 * Makes no model calls: every retrieved passage in `results-latest.json` already
 * carries its distance, and the answer key already says which documents were the
 * right ones — so each retrieval is a labelled observation and the cutoff is a
 * measurement rather than a guess.
 *
 * **This closes a hole that has been open since M0.6.** `RETRIEVAL_DISTANCE_THRESHOLD`
 * is configured but not enforced, because the 0.902 in `env.schema.ts` was derived
 * for `bge-m3` at 1024 dimensions and the current provider is
 * `gemini-embedding-001` at 768. `docs/retrieval-threshold-study.md` concludes
 * that a distance threshold is *not portable across embedding models* and records
 * an outage caused by exactly that, so enforcing today's value would reproduce the
 * bug the study exists to prevent. This is the method that produces a value that
 * is not a guess.
 *
 * Read the separation band before the F1. A cutoff inside a wide empty band is
 * robust; one taken from a best-F1 where the classes overlap is a guess with a
 * decimal point on it. If this reports no separation, the honest outcome is to
 * leave the threshold unenforced and say why.
 */

import { existsSync, readFileSync } from 'node:fs';
import { flagChoice, flagValue } from './harness/flags';
import { sweepThreshold, type LabelledValue } from './metrics/threshold-sweep';
import { EVAL_MODES } from './types';
import type { ResultsFile } from './types';

function main(): void {
  const argv = process.argv.slice(2);
  const resultsPath = flagValue(argv, '--results', './evals/results-latest.json');
  const mode = flagChoice(argv, '--mode', EVAL_MODES, 'agent');

  if (!existsSync(resultsPath)) throw new Error(`No results at ${resultsPath}. Run \`pnpm eval\`.`);
  const results = JSON.parse(readFileSync(resultsPath, 'utf8')) as ResultsFile;
  const suite = results.modes[mode];
  if (!suite) throw new Error(`${resultsPath} has no "${mode}" results.`);

  const observations: LabelledValue[] = [];

  for (const result of suite.results) {
    // A question with no expected documents cannot label anything: "not one of
    // the expected documents" is not the same as "irrelevant" when nothing was
    // expected, and treating the unanswerable set's retrievals as negatives would
    // push the cutoff down for the wrong reason.
    if (result.question.expectedDocIds.length === 0) continue;

    const expected = new Set(result.question.expectedDocIds);
    for (const evidence of result.run.evidence) {
      observations.push({
        value: evidence.distance,
        positive: evidence.docId !== null && expected.has(evidence.docId),
        label: `${result.question.id} → ${evidence.docId ?? evidence.evidenceId}`,
      });
    }
  }

  if (observations.length === 0) {
    throw new Error('No labelled retrievals in these results — nothing to sweep.');
  }

  const swept = sweepThreshold(observations, 'lower-is-positive');

  console.log(`\nRETRIEVAL_DISTANCE_THRESHOLD sweep — ${mode}, ${suite.config.subset}`);
  console.log(`  embedding model  ${suite.config.embeddingModel}`);
  console.log(
    `  observations     ${observations.length} retrieval(s): ` +
      `${swept.counts.positives} relevant, ${swept.counts.negatives} not\n`,
  );

  console.log('  threshold   TP   FP   TN   FN   precision  recall     F1');
  console.log(`  ${'-'.repeat(58)}`);
  for (const point of swept.points) {
    console.log(
      `  ${point.threshold.toFixed(4).padStart(9)}  ` +
        `${String(point.truePositives).padStart(3)}  ${String(point.falsePositives).padStart(3)}  ` +
        `${String(point.trueNegatives).padStart(3)}  ${String(point.falseNegatives).padStart(3)}  ` +
        `${point.precision.toFixed(3).padStart(9)}  ${point.recall.toFixed(3).padStart(6)}  ` +
        `${point.f1.toFixed(3).padStart(5)}`,
    );
  }

  console.log('');
  if (swept.best) {
    console.log(
      `  best F1     ${swept.best.f1.toFixed(3)} at ${swept.best.threshold.toFixed(4)} ` +
        `(precision ${swept.best.precision.toFixed(3)}, recall ${swept.best.recall.toFixed(3)})`,
    );
  }

  if (swept.separation) {
    console.log(
      `  separation  the classes do not overlap: an empty band from ` +
        `${swept.separation.low.toFixed(4)} to ${swept.separation.high.toFixed(4)} ` +
        `(width ${swept.separation.width.toFixed(4)}, midpoint ${swept.separation.midpoint.toFixed(4)})`,
    );
    console.log(
      `\n  A cutoff inside that band is a measurement. ` +
        `RETRIEVAL_DISTANCE_THRESHOLD=${swept.separation.midpoint.toFixed(2)} is defensible ` +
        `for ${suite.config.embeddingModel}, and only for it.\n`,
    );
  } else {
    console.log(
      '  separation  NONE — relevant and irrelevant retrievals overlap on distance.\n' +
        '\n  The honest conclusion is to leave RETRIEVAL_DISTANCE_THRESHOLD unenforced.\n' +
        '  Any cutoff here trades recall for precision with no clean split to point at,\n' +
        '  which is how docs/retrieval-threshold-study.md describes the outage it exists\n' +
        '  to prevent. Report the overlap; do not pick the best-F1 number and call it derived.\n',
    );
  }
}

try {
  main();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

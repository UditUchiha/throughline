/**
 * The CI gate (PLAN.md §5/M6.3).
 *
 *   pnpm eval:compare [--results=<path>] [--baseline=<path>] [--mode=agent]
 *
 * Compares `evals/results-latest.json` against the committed `evals/baseline.json`
 * and exits non-zero on a regression, naming the metric and the delta. Makes no
 * model calls — it reads two files.
 *
 * Two kinds of check, and the distinction matters:
 *
 * - **Floors** are absolute and have no tolerance. Citation validity and injection
 *   resistance are deterministic properties, not scores: a single failure is a
 *   real defect, so anything below the floor fails regardless of what the baseline
 *   happened to record.
 * - **Tolerances** are for judged and retrieval metrics, which move between runs
 *   because a model is in the loop. A tolerance that is too tight makes the gate
 *   noise, and a gate that cries wolf gets disabled; too loose and it catches
 *   nothing. The values in `baseline.json` carry their own justification.
 *
 * Both kinds assume the run they are given is a measurement. Two things are
 * checked before either runs — a subset mismatch and a failure rate — because a
 * gate that cannot tell "nothing regressed" from "nothing was measured" reports
 * the first when it means the second, and that is the one failure mode a gate is
 * not allowed to have.
 */

import { existsSync, readFileSync } from 'node:fs';
import { failureRate, tooManyFailures } from './harness/comparability';
import { flagChoice, flagValue } from './harness/flags';
import { EVAL_MODES } from './types';
import type { EvalMode, ResultsFile, SuiteMetrics } from './types';

/**
 * Keys are `SuiteMetrics` field names, or `guardrail:<name>` for a per-guardrail
 * pass rate. A plain string rather than `keyof SuiteMetrics` because of the
 * second form, and because a baseline is data on disk that may name a metric this
 * build no longer has — which `numeric` reports rather than crashes on.
 */
interface BaselineMode {
  subset: string;
  questionCount: number;
  metrics: Record<string, number | null>;
  tolerances: Record<string, number>;
  floors: Record<string, number>;
}

interface BaselineFile {
  schemaVersion: 1;
  recordedAt: string;
  recordedFrom: string;
  notes: string;
  modes: Partial<Record<EvalMode, BaselineMode>>;
}

interface Failure {
  metric: string;
  kind: 'floor' | 'regression' | 'missing';
  message: string;
}

function readJson<T>(path: string, label: string): T {
  if (!existsSync(path)) throw new Error(`No ${label} at ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/**
 * Resolves a metric key against a finished run.
 *
 * `guardrail:<name>` reaches into the per-guardrail pass rates, which is what
 * lets `exfiltration` carry a hard floor of 1.0 alongside the scored metrics. A
 * guardrail that stops being registered resolves to null rather than to zero, so
 * a gate on it fails as "not measured" instead of silently reporting a
 * catastrophic regression the run never actually had.
 */
function numeric(metrics: SuiteMetrics, key: string): number | null {
  if (key.startsWith('guardrail:')) {
    const rate = metrics.guardrailPassRate[key.slice('guardrail:'.length)];
    return typeof rate === 'number' ? rate : null;
  }
  const value = (metrics as unknown as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
}

export function compareAgainstBaseline(
  metrics: SuiteMetrics,
  baseline: BaselineMode,
): { failures: Failure[]; lines: string[] } {
  const failures: Failure[] = [];
  const lines: string[] = [];

  for (const [metric, floor] of Object.entries(baseline.floors)) {
    const actual = numeric(metrics, metric);
    if (actual === null) {
      // A floor on a metric nobody measured is a silent pass, which is exactly how
      // a security gate stops gating. Missing is a failure.
      failures.push({
        metric,
        kind: 'missing',
        message: `${metric}: floor ${floor} is set but the run reported no value`,
      });
      continue;
    }
    const ok = actual >= floor;
    lines.push(
      `  ${ok ? 'ok  ' : 'FAIL'} ${metric.padEnd(32)} ${actual.toFixed(3)} (floor ${floor})`,
    );
    if (!ok) {
      failures.push({
        metric,
        kind: 'floor',
        message:
          `${metric}: ${actual.toFixed(3)} is below the hard floor of ${floor} ` +
          `(shortfall ${(floor - actual).toFixed(3)})`,
      });
    }
  }

  for (const [metric, expected] of Object.entries(baseline.metrics)) {
    if (expected === null || expected === undefined) continue;
    if (metric in baseline.floors) continue;

    const tolerance = baseline.tolerances[metric] ?? 0;
    const actual = numeric(metrics, metric);

    if (actual === null) {
      // Not a failure: `--no-judge` legitimately produces no judged metrics, and a
      // deterministic-only run is a useful thing to gate on its own terms.
      lines.push(`  skip ${metric.padEnd(32)} not measured in this run`);
      continue;
    }

    const delta = actual - expected;
    const ok = delta >= -tolerance;
    lines.push(
      `  ${ok ? 'ok  ' : 'FAIL'} ${metric.padEnd(32)} ${actual.toFixed(3)} ` +
        `vs ${expected.toFixed(3)} (${delta >= 0 ? '+' : ''}${delta.toFixed(3)}, tolerance ${tolerance})`,
    );
    if (!ok) {
      failures.push({
        metric,
        kind: 'regression',
        message:
          `${metric}: ${actual.toFixed(3)} vs baseline ${expected.toFixed(3)} — ` +
          `regressed by ${Math.abs(delta).toFixed(3)}, tolerance is ${tolerance}`,
      });
    }
  }

  return { failures, lines };
}

function main(): void {
  const argv = process.argv.slice(2);
  const resultsPath = flagValue(argv, '--results', './evals/results-latest.json');
  const baselinePath = flagValue(argv, '--baseline', './evals/baseline.json');
  const mode = flagChoice(argv, '--mode', EVAL_MODES, 'agent');

  const results = readJson<ResultsFile>(resultsPath, 'results file');
  const baselineFile = readJson<BaselineFile>(baselinePath, 'baseline');

  const suite = results.modes[mode];
  const baseline = baselineFile.modes[mode];

  if (!suite) throw new Error(`${resultsPath} has no "${mode}" results.`);
  if (!baseline) throw new Error(`${baselinePath} has no "${mode}" baseline.`);

  console.log(`\neval gate — ${mode}`);
  console.log(
    `  results  ${resultsPath} (${suite.config.subset}, ${suite.metrics.questions} questions)`,
  );
  console.log(
    `  baseline ${baselinePath} (${baseline.subset}, ${baseline.questionCount} questions)\n`,
  );

  // A subset mismatch makes every comparison meaningless — nine questions and
  // fifty-nine questions do not produce comparable rates — so it fails outright
  // rather than producing a confidently wrong verdict.
  if (suite.config.subset !== baseline.subset) {
    console.error(
      `  Refusing to compare: results are "${suite.config.subset}" but the baseline is ` +
        `"${baseline.subset}". Record a baseline for this subset, or run the other one.\n`,
    );
    process.exitCode = 1;
    return;
  }

  // A run that mostly failed is not a run. Its floors survive — citation validity
  // and injection resistance are computed over the runs that returned, and an
  // answer with no citations is vacuously valid — so every check below would pass
  // on a suite that answered three questions of fifty-nine. `renderTable` already
  // refused to *draw* this comparison; refusing to draw it while still gating on
  // it meant the honest half was the half nobody's merge depended on.
  if (tooManyFailures(suite.metrics)) {
    console.error(
      `  Refusing to gate: ${suite.metrics.failed} of ${suite.metrics.questions} runs failed ` +
        `(${(failureRate(suite.metrics) * 100).toFixed(0)}%). A failed run scores zero rather ` +
        `than being dropped, and the deterministic floors are computed over the runs that ` +
        `returned — so these numbers would pass every check while measuring an outage.
` +
        `  Re-run the suite; failed runs are not cached, so only the missing questions cost ` +
        `anything.
`,
    );
    process.exitCode = 1;
    return;
  }

  const { failures, lines } = compareAgainstBaseline(suite.metrics, baseline);
  console.log(lines.join('\n'));

  if (failures.length === 0) {
    console.log('\n  No regression beyond tolerance.\n');
    return;
  }

  console.error(`\n  ${failures.length} metric(s) regressed:\n`);
  for (const failure of failures) console.error(`    - ${failure.message}`);
  console.error('');
  process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

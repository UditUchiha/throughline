import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EvalMode, ResultsFile, SuiteMetrics, SuiteResult } from '../types';
import { tooManyFailures } from './comparability';

/**
 * Renders the metrics table and merges the results file.
 *
 * **Merged, not overwritten.** A full comparison is ~470 model calls against a
 * free tier of ~20 per window, so the agent pass and the baseline pass will
 * normally be run hours apart. Overwriting would mean running the baseline
 * destroys the agent's numbers and the headline delta cannot be reported without
 * paying for both again.
 */

// `n/a` rather than an em dash: the table is column-aligned with padStart, and a
// multi-byte glyph renders at a different width in enough terminals to skew it.
function pct(value: number | null): string {
  return value === null ? '   n/a' : `${(value * 100).toFixed(1).padStart(5)}%`;
}

function num(value: number, digits = 2): string {
  return value.toFixed(digits);
}

interface Row {
  label: string;
  value: string;
  /** Shown in a second column when both modes are present. */
  compare?: string;
  delta?: string;
}

function deltaOf(a: number | null, b: number | null): string {
  if (a === null || b === null) return '   n/a';
  const difference = (a - b) * 100;
  const sign = difference > 0 ? '+' : '';
  // Pad the signed number as a whole, not the digits: padding first puts a space
  // between the sign and the value ("+ 21.0pp").
  return `${`${sign}${difference.toFixed(1)}`.padStart(6)}pp`;
}

/**
 * The rows of the metrics table, as `[label, how to read it off a suite]`.
 *
 * One list with a selector rather than two lists keyed by display string. The
 * parallel version silently disagreed with itself: a metric added to the first
 * list and forgotten in the second rendered its own value normally and `n/a` in
 * the comparison column, so the failure looked like a mode that had not been run
 * rather than like a bug. Reading both columns through the same function makes
 * that unrepresentable — and the label stops being an identifier, so it can be
 * changed without silently unlinking a row from its comparison.
 */
const METRIC_ROWS: [label: string, of: (metrics: SuiteMetrics) => number | null][] = [
  ['Answer correctness', (m) => m.answerCorrectness],
  ['  … correct or partial', (m) => m.partialCorrectness],
  ['Citation support', (m) => m.citationSupport],
  ['Abstention correctness', (m) => m.abstentionCorrectness],
  ['Recall@k (ledger docs)', (m) => m.recallAtK],
  ['Citation validity', (m) => m.citationValidity],
  ['Plan source coverage', (m) => m.planSourceCoverage],
  ['Meets minHops', (m) => m.meetsMinHops],
  ['Injection resistance', (m) => m.injectionResistance],
];

function metricRows(metrics: SuiteMetrics, other: SuiteMetrics | null): Row[] {
  return METRIC_ROWS.map(([label, of]) => {
    const value = of(metrics);
    const otherValue = other ? of(other) : null;
    return {
      label,
      value: pct(value),
      compare: other ? pct(otherValue) : undefined,
      delta: other ? deltaOf(value, otherValue) : undefined,
    };
  });
}

export function renderTable(result: SuiteResult, other: SuiteResult | null): string {
  const { metrics, config } = result;
  const lines: string[] = [];

  // A delta between nine questions and fifty-nine is not a delta, it is two
  // unrelated rates subtracted from each other. Because the results file is
  // *merged* per mode, that mismatch is the normal state of affairs halfway
  // through a comparison — so it is refused rather than rendered.
  const mismatched = other !== null && other.config.subset !== config.subset;

  // The subset check is not enough on its own. A pass that ran the *right*
  // questions and had most of them die — a quota wall answers every provider with
  // `rate limit reached` — produces a suite with the correct shape and scores of
  // zero, and subtracting that yields a spectacular, entirely fictional delta in
  // this mode's favour. Observed, not theorised: the first baseline pass came back
  // 56 failed of 59. A comparison has to be refused for that too.
  const unusable = other !== null && tooManyFailures(other.metrics);

  // The mirror of the check above, and the one that was missing. Guarding only
  // the *other* mode meant a broken run in the driver's seat rendered a full
  // delta table about itself: the first real baseline pass walled after 21 of 59
  // and printed "single-shot 66.7% vs agent 61.0%, +5.6pp" — the non-agentic
  // control apparently beating the agent it is the control for. Judged rates are
  // computed over the runs a judge actually saw, so 38 failures leave the
  // denominator small and flattering, while the deterministic metrics score those
  // same failures as zero. Half the column is optimistic and half is pessimistic,
  // which is worse than either.
  const selfUnusable = tooManyFailures(metrics);

  const compared = other !== null && !mismatched && !unusable && !selfUnusable;

  lines.push('');
  lines.push(`  ${config.mode}  —  ${metrics.questions} question(s), ${metrics.failed} failed`);
  lines.push(
    `  subset=${config.subset}  connectors=${config.connectors}  memory=${config.memory}  ` +
      `answerer=${config.answerProvider}`,
  );
  lines.push(
    `  judge=${config.judge.model ?? 'none'}` +
      (config.judge.model
        ? config.judge.separateProvider
          ? ' (different provider than the answerer; same tier — see PLAN.md §7)'
          : ' ⚠ SAME PROVIDER AND MODEL AS THE ANSWERER — not an independent judge'
        : ''),
  );
  if (selfUnusable) {
    lines.push(
      `  ⚠ ${metrics.failed} of ${metrics.questions} runs FAILED — the rates below are not a ` +
        `measurement of this system. Judged metrics are computed over the runs a judge saw ` +
        `(${metrics.questions - metrics.judgeUnavailable} here), so they read high, while the ` +
        `deterministic ones score every failure as zero. No delta is shown against the other ` +
        `mode for the same reason. Re-run; failed runs are never cached, so only the missing ` +
        `questions cost anything.`,
    );
  }
  if (mismatched && other) {
    lines.push(
      `  ⚠ ${other.config.mode} results exist but ran a different question set ` +
        `("${other.config.subset}" vs "${config.subset}") — no delta is shown, because ` +
        `subtracting one from the other would not mean anything. Run both over the same set.`,
    );
  } else if (unusable && other) {
    lines.push(
      `  ⚠ ${other.config.mode} results exist but ${other.metrics.failed} of ` +
        `${other.metrics.questions} runs failed — no delta is shown, because a mode whose runs ` +
        `died scores zero on everything and the difference would measure the outage, not the ` +
        `system. Re-run it; failed runs are not cached, so only the missing questions cost anything.`,
    );
  }
  lines.push('');

  const width = 26;
  const header = compared
    ? `  ${'metric'.padEnd(width)}${result.config.mode.padStart(8)}${other.config.mode.padStart(14)}${'delta'.padStart(12)}`
    : `  ${'metric'.padEnd(width)}${'value'.padStart(8)}`;
  lines.push(header);
  lines.push(`  ${'-'.repeat(header.length - 2)}`);

  for (const row of metricRows(metrics, other?.metrics ?? null)) {
    lines.push(
      compared
        ? `  ${row.label.padEnd(width)}${row.value.padStart(8)}${(row.compare ?? '').padStart(14)}${(row.delta ?? '').padStart(12)}`
        : `  ${row.label.padEnd(width)}${row.value.padStart(8)}`,
    );
  }

  lines.push('');
  if (config.judge.model !== null && metrics.judgeUnavailable > 0) {
    lines.push(
      `  ⚠ ${metrics.judgeUnavailable} of ${metrics.questions} question(s) could not be judged ` +
        `(the judge call failed). Every judged rate above is over the rest — re-run to fill them in.`,
    );
    lines.push('');
  }
  // Against the runs that answered, not against every run: an abstention cites
  // nothing and is correct to. The gap between these two numbers is answers that
  // asserted something and grounded none of it.
  lines.push(
    `  cited / answered (not abstained)  ${metrics.citedAnswers}/${metrics.answeredRuns}` +
      (metrics.citedAnswers < metrics.answeredRuns
        ? `  ⚠ ${metrics.answeredRuns - metrics.citedAnswers} answer(s) asserted something and cited nothing`
        : ''),
  );
  lines.push(
    `  injection actually exercised  ${metrics.injectionExercised}/${metrics.questions} run(s)`,
  );
  lines.push(
    `  mean hops / sub-questions     ${num(metrics.meanHops)} / ${num(metrics.meanSubQuestions)}`,
  );
  lines.push(`  mean latency                  ${Math.round(metrics.meanLatencyMs)}ms`);
  lines.push(
    `  tokens in / out               ${metrics.totalInputTokens} / ${metrics.totalOutputTokens}`,
  );
  lines.push(
    `  estimated cost                ${
      metrics.totalCostUsd === null
        ? 'unknown (an unpriced model served a call)'
        : `$${metrics.totalCostUsd.toFixed(4)}`
    }`,
  );

  lines.push('');
  lines.push('  guardrails (pass rate over the runs above)');
  for (const [name, rate] of Object.entries(metrics.guardrailPassRate)) {
    lines.push(`    ${name.padEnd(width - 2)}${pct(rate)}`);
  }

  const memory = metrics.memory;
  lines.push('');
  lines.push('  long-term memory funnel');
  lines.push(
    `    runs skipped by the gate   ${memory.runsSkippedByGate}/${metrics.questions}` +
      `  (no first-person marker, so no extraction call at all)`,
  );
  lines.push(
    `    runs proposing a candidate ${memory.runsProposingACandidate}/${metrics.questions}` +
      (memory.runsSkippedByGate > 0
        ? `  — of the ${metrics.questions - memory.runsSkippedByGate} that reached the extractor`
        : ''),
  );
  lines.push(
    `    proposed → dropped / merged / stored   ${memory.proposed} → ${memory.droppedLowImportance} / ${memory.mergedDuplicate} / ${memory.stored}`,
  );
  lines.push(
    `    retention rate (stored/proposed)       ${
      memory.retentionRate === null
        ? 'n/a (nothing proposed)'
        : `${(memory.retentionRate * 100).toFixed(1)}%`
    }`,
  );
  lines.push(
    `    runs influenced by a recalled fact     ${memory.runsWithRecall}` +
      (memory.runsWithRecall === 0
        ? '  (no cross-question contamination)'
        : '  ⚠ these scores are order-dependent'),
  );
  lines.push('');

  return lines.join('\n');
}

/** Per-question detail, so a number in the table can be traced to an answer. */
export function renderFailures(result: SuiteResult): string {
  const interesting = result.results.filter(
    (r) =>
      r.run.error !== null ||
      !r.citations.valid ||
      (r.injection.exercised && !r.injection.resisted) ||
      (r.judge !== null && r.judge.correctness === 'incorrect') ||
      (r.recall.value !== null && r.recall.value < 1),
  );

  if (interesting.length === 0) return '  nothing to flag.\n';

  const lines = [`  ${interesting.length} question(s) worth reading:`, ''];
  for (const r of interesting) {
    const marks: string[] = [];
    // Collapsed before truncating: a failover error is multi-line ("every provider
    // failed:" then one indented line per provider), and slicing it raw turns one
    // failure into several rows that look like separate questions.
    if (r.run.error) {
      marks.push(`FAILED: ${r.run.error.replace(/\s+/g, ' ').slice(0, 100)}`);
    }
    if (r.recall.value !== null && r.recall.value < 1) {
      marks.push(`recall ${r.recall.hits.length}/${r.recall.expected.length}`);
    }
    if (!r.citations.valid) marks.push('invalid citations');
    if (r.injection.exercised && !r.injection.resisted) marks.push('INJECTION NOT RESISTED');
    if (r.judge?.correctness === 'incorrect') marks.push('judged incorrect');
    lines.push(`  - ${r.question.id.padEnd(42)} ${marks.join(', ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Drops the passage text before the results are written.
 *
 * It is roughly 90% of the file and every word of it is already in
 * `corpus/generated`, reachable by the `docId` that stays. At 59 questions the
 * difference is about a megabyte of duplicated corpus prose per mode, in a file
 * whose whole purpose is to be readable in a diff. The full text survives in
 * `evals/.cache/`, which is where anyone inspecting a single answer looks anyway.
 */
function withoutPassageText(result: SuiteResult): SuiteResult {
  return {
    ...result,
    results: result.results.map((question) => ({
      ...question,
      run: {
        ...question.run,
        evidence: question.run.evidence.map((evidence) => {
          const slim = { ...evidence };
          delete slim.text;
          return slim;
        }),
      },
    })),
  };
}

export function writeResults(path: string, result: SuiteResult): ResultsFile {
  mkdirSync(dirname(path), { recursive: true });

  const existing = readResults(path) ?? { schemaVersion: 1 as const, updatedAt: '', modes: {} };
  const merged: ResultsFile = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    modes: { ...existing.modes, [result.config.mode]: withoutPassageText(result) },
  };

  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

export function readResults(path: string): ResultsFile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ResultsFile;
  } catch {
    return null;
  }
}

export function otherMode(mode: EvalMode): EvalMode {
  return mode === 'agent' ? 'single-shot' : 'agent';
}

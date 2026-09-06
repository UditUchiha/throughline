import { renderTable } from './report';
import type { SuiteMetrics, SuiteResult } from '../types';

/**
 * The two conditions under which the comparison column refuses to render.
 *
 * Both are honesty controls rather than formatting: the headline claim of this
 * whole project is a delta between two modes, and each of these is a way to
 * produce a large, confident, meaningless one. Both were hit for real while M6
 * was being built.
 */

function metrics(overrides: Partial<SuiteMetrics> = {}): SuiteMetrics {
  return {
    questions: 59,
    failed: 0,
    judgeUnavailable: 0,
    recallAtK: 0.925,
    citationValidity: 1,
    answeredRuns: 50,
    citedAnswers: 43,
    answerCorrectness: 0.61,
    partialCorrectness: 0.966,
    citationSupport: 0.884,
    abstentionCorrectness: 1,
    injectionResistance: 1,
    injectionExercised: 9,
    planSourceCoverage: 0.925,
    meetsMinHops: 0.966,
    meanHops: 1.46,
    meanSubQuestions: 2.31,
    meanLatencyMs: 17329,
    totalCostUsd: 0.1275,
    totalInputTokens: 285740,
    totalOutputTokens: 27963,
    guardrailPassRate: { exfiltration: 1 },
    memory: {
      runsSkippedByGate: 0,
      runsProposingACandidate: 0,
      proposed: 0,
      droppedLowImportance: 0,
      mergedDuplicate: 0,
      stored: 0,
      retentionRate: null,
      runsWithRecall: 0,
    },
    ...overrides,
  };
}

function suite(
  mode: SuiteResult['config']['mode'],
  subset: string,
  overrides: Partial<SuiteMetrics> = {},
): SuiteResult {
  return {
    config: {
      mode,
      startedAt: '2026-09-06T00:00:00.000Z',
      finishedAt: '2026-09-06T01:00:00.000Z',
      questionCount: overrides.questions ?? 59,
      subset,
      connectors: false,
      memory: 'reset',
      answerProvider: 'gemini→groq',
      judge: {
        model: 'groq/openai/gpt-oss-120b',
        separateProvider: true,
        tierSeparation: false,
      },
      embeddingModel: 'gemini/gemini-embedding-001@768',
      topK: 5,
    },
    metrics: metrics(overrides),
    results: [],
  };
}

describe('renderTable — when a delta may be shown', () => {
  it('shows the delta when both modes ran the same question set and both completed', () => {
    const table = renderTable(
      suite('agent', 'full'),
      suite('single-shot', 'full', { answerCorrectness: 0.4 }),
    );

    expect(table).toContain('single-shot');
    expect(table).toContain('delta');
    // 0.610 - 0.400 = +21.0 percentage points.
    expect(table).toContain('+21.0pp');
  });

  it('refuses a delta when the mode being reported is itself mostly failures', () => {
    // The mirror of the check below, and the one that was missing. Guarding only
    // the *other* mode meant a broken run in the driver's seat rendered a full
    // delta about itself. Observed on the first real baseline pass: it walled
    // after 21 of 59 and printed "single-shot 66.7% vs agent 61.0%, +5.6pp" — the
    // non-agentic control apparently beating the agent it is the control for.
    //
    // The number is not even consistently wrong. Judged rates are computed over
    // the runs a judge saw, so 38 failures leave a small, flattering denominator;
    // the deterministic metrics score those same failures as zero. Half the
    // column reads high and half reads low.
    const table = renderTable(
      suite('single-shot', 'full', {
        failed: 38,
        judgeUnavailable: 35,
        answerCorrectness: 0.667,
      }),
      suite('agent', 'full'),
    );

    expect(table).toContain('38 of 59 runs FAILED');
    expect(table).toContain('not a measurement of this system');
    // Says how small the judged denominator actually was, rather than printing
    // 66.7% as though it were over 59.
    expect(table).toContain('(24 here)');
    expect(table).not.toMatch(/[-+]?\d+\.\dpp/);
  });

  it('still shows a delta when the failures are on the healthy side of the line', () => {
    // One question of 59 dying to a 5xx must not suppress the comparison, or the
    // delta becomes unreportable in practice and the table stops being used.
    const table = renderTable(
      suite('agent', 'full', { failed: 1 }),
      suite('single-shot', 'full', { answerCorrectness: 0.4 }),
    );

    expect(table).toContain('+21.0pp');
    expect(table).not.toContain('not a measurement');
  });

  it('refuses a delta across different question sets', () => {
    // The results file is merged per mode, so "agent over 59, baseline over 9" is
    // the normal halfway state of a comparison — not an error, but not subtractable.
    const table = renderTable(suite('agent', 'full'), suite('single-shot', 'pr', { questions: 9 }));

    expect(table).toContain('ran a different question set');
    // No delta column at all: the header is the single-value form, and no
    // percentage-point figure appears anywhere. Matched as a figure rather than
    // the bare string "pp", which also occurs inside "Citation support".
    expect(table).toContain('metric                       value');
    expect(table).not.toMatch(/[-+]?\d+\.\dpp/);
  });

  it('refuses a delta against a mode whose runs mostly died', () => {
    // Observed: the first baseline pass hit the free-tier wall and came back 56
    // failed of 59. Those runs score zero on everything, so the delta would have
    // been enormous and entirely fictional — a measurement of the outage.
    const table = renderTable(
      suite('agent', 'full'),
      suite('single-shot', 'full', {
        failed: 56,
        answerCorrectness: 0.05,
        recallAtK: 0.05,
      }),
    );

    expect(table).toContain('56 of 59 runs failed');
    expect(table).toContain('measure the outage, not the system');
    expect(table).toContain('metric                       value');
    expect(table).not.toMatch(/[-+]?\d+\.\dpp/);
  });

  it('tolerates a single transient failure rather than refusing the comparison', () => {
    // One question dying to a 5xx in 59 is noise. Refusing over it would make the
    // delta unreportable in practice, which is its own kind of dishonesty.
    const table = renderTable(
      suite('agent', 'full'),
      suite('single-shot', 'full', { failed: 1, answerCorrectness: 0.4 }),
    );

    expect(table).toContain('delta');
    expect(table).toContain('+21.0pp');
  });
});

describe('renderTable — what it always says out loud', () => {
  it('flags a judge that shares the answerer model', () => {
    const shared = suite('agent', 'full');
    shared.config.judge = {
      model: 'gemini/gemini-3.5-flash',
      separateProvider: false,
      tierSeparation: false,
    };

    expect(renderTable(shared, null)).toContain('SAME PROVIDER AND MODEL AS THE ANSWERER');
  });

  it('flags answers that asserted something and cited nothing', () => {
    // citationValidity rises as the agent cites less, so this line is what stops
    // "100% valid citations" from reading as "everything is grounded".
    expect(renderTable(suite('agent', 'full'), null)).toContain(
      '7 answer(s) asserted something and cited nothing',
    );
  });

  it('flags questions the judge could not score', () => {
    const table = renderTable(suite('agent', 'full', { judgeUnavailable: 4 }), null);

    expect(table).toContain('4 of 59 question(s) could not be judged');
  });

  it('says how many runs actually exercised the injection payloads', () => {
    // 100% resistance over zero exercised runs would be a vacuous pass.
    expect(renderTable(suite('agent', 'full'), null)).toContain(
      'injection actually exercised  9/59',
    );
  });
});

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EvalMode, EvalRun, JudgeVerdict } from '../types';

/**
 * Per-question result cache, so a killed run resumes instead of restarting.
 *
 * This is not an optimisation; it is what makes the suite runnable at all. A full
 * agent pass is ~295 model calls against a free tier of ~20 per window, so it
 * will be interrupted — by quota, by a laptop closing, by a 429 storm no failover
 * absorbs. Without a cache, question 47 failing means paying for questions 1–46
 * again, and in practice that means the suite gets run once and then never.
 *
 * Runs and judgments are cached separately because they invalidate for different
 * reasons: re-judging with a different model must not re-run the agent, and
 * re-running the agent must not silently keep a verdict about an older answer —
 * so the judgment's key includes the answer it was made about.
 */

const CACHE_ROOT = './evals/.cache';

/**
 * Everything that changes what a run *means*.
 *
 * Deliberately not the full config. `--limit` and `--concurrency` change which
 * questions get run and how fast, not what any one of them produces; folding
 * those in would invalidate the cache on every narrowing and defeat the point.
 */
export interface RunFingerprint {
  mode: EvalMode;
  answerProvider: string;
  embeddingModel: string;
  topK: number;
  maxHops: number;
  connectors: boolean;
  memory: 'reset' | 'accumulate';
  /** The registered tool menu, which is what the planner actually sees. */
  tools: string[];
  /**
   * The registered guardrails, because their verdicts are cached with the run.
   *
   * `EvalRun.guardrails` is produced by the live pipeline and stored alongside
   * the answer — deliberately, so the suite never grades an answer against a
   * newer set of checks than it was produced under. The corollary was missing:
   * without the set in the fingerprint, adding or removing a guardrail left every
   * cached run scoring against the old one, and `baseline.json` carries a hard
   * floor of 1.0 on `guardrail:exfiltration`. A gate on a check that is no longer
   * registered would have kept passing on replayed verdicts.
   *
   * Names only, and that is a real limit rather than an oversight: this catches a
   * guardrail appearing or disappearing, not one whose logic changed underneath
   * the same name. Hashing behaviour is not something a name list can do, and
   * `--fresh` is the answer for that case.
   */
  guardrails: string[];
  /**
   * What `EvalRun.hops` counts. Runs cached before it meant follow-up rounds
   * stored `reflect` passes instead — one higher — and would replay as if every
   * question had looped. Naming the meaning invalidates them.
   */
  hops: 'retrieval-rounds';
}

interface CachedRun {
  fingerprint: string;
  run: EvalRun;
}

interface CachedJudgment {
  fingerprint: string;
  /** Hash of the answer text this verdict was made about. */
  answerHash: string;
  judgeModel: string;
  verdict: JudgeVerdict;
}

function hash(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

/** Question ids contain dots but never separators, so they are safe as filenames. */
function pathFor(kind: 'runs' | 'judgments', mode: EvalMode, questionId: string): string {
  return join(CACHE_ROOT, kind, mode, `${questionId}.json`);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    // A half-written file from an interrupted run is expected, not exceptional.
    // Treating it as a miss costs one question; throwing would abort the resume
    // that the cache exists to make possible.
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export class EvalCache {
  private readonly fingerprint: string;

  constructor(
    fingerprint: RunFingerprint,
    /** When true, every read misses. The run still writes, so `--fresh` refills. */
    private readonly disabled: boolean,
  ) {
    this.fingerprint = hash(fingerprint);
  }

  readRun(mode: EvalMode, questionId: string): EvalRun | null {
    if (this.disabled) return null;
    const cached = readJson<CachedRun>(pathFor('runs', mode, questionId));
    if (!cached || cached.fingerprint !== this.fingerprint) return null;
    // Belt and braces with the guard in `writeRun`: a cache file written by an
    // older build could still hold a failure, and inheriting one is the failure
    // mode that produces a confidently wrong results table.
    if (cached.run.error !== null) return null;
    return cached.run;
  }

  /**
   * Caches a run — unless it failed.
   *
   * Observed the hard way on the first full baseline pass: the free tier ran out
   * partway through, 56 of 59 questions came back
   * `Every configured LLM provider failed`, and every one of those failures was
   * written to the cache. The next invocation then read them back as finished
   * work and reported a suite where the baseline scored zero on everything —
   * which is not a measurement of a single-shot baseline, it is a measurement of
   * a quota wall.
   *
   * A cache whose whole purpose is "a killed run resumes" must not persist the
   * thing that killed it. Failures are therefore always re-attempted, which is
   * also why {@link EvalCache} needs no separate invalidation for them.
   */
  writeRun(run: EvalRun): void {
    if (run.error !== null) return;
    const entry: CachedRun = { fingerprint: this.fingerprint, run };
    writeJson(pathFor('runs', run.mode, run.questionId), entry);
  }

  readJudgment(
    mode: EvalMode,
    questionId: string,
    answerText: string,
    judgeModel: string,
  ): JudgeVerdict | null {
    if (this.disabled) return null;
    const cached = readJson<CachedJudgment>(pathFor('judgments', mode, questionId));
    if (!cached) return null;
    // All three must match. The answer hash is what stops a re-run's new answer
    // from inheriting a verdict about the answer it replaced — the one cache bug
    // that would corrupt the headline number rather than merely wasting a call.
    if (cached.fingerprint !== this.fingerprint) return null;
    if (cached.answerHash !== hash(answerText)) return null;
    if (cached.judgeModel !== judgeModel) return null;
    return cached.verdict;
  }

  writeJudgment(
    mode: EvalMode,
    questionId: string,
    answerText: string,
    verdict: JudgeVerdict,
  ): void {
    const entry: CachedJudgment = {
      fingerprint: this.fingerprint,
      answerHash: hash(answerText),
      judgeModel: verdict.judgeModel,
      verdict,
    };
    writeJson(pathFor('judgments', mode, questionId), entry);
  }
}

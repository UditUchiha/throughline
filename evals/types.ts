import type { CorpusSource } from '../src/common/types/knowledge.types';
import type { QuestionCategory } from '../src/agent/examples/example-question';

/**
 * How a question was answered.
 *
 * `single-shot` is the non-agentic control PLAN.md §5/M6.1 calls the headline
 * comparison: one broad retrieval, one synthesis call, no triage, no plan, no
 * reflection. It is a *mode of the same harness* rather than a second agent, so
 * every metric below is computed by identical code over both.
 */
export type EvalMode = 'agent' | 'single-shot';

export const EVAL_MODES: EvalMode[] = ['agent', 'single-shot'];

/**
 * One question from the answer key, with the ledger already resolved.
 *
 * `expectedDocIds` is the recall@k target and the reason this project can score
 * retrieval deterministically: a fact names the documents that express it, so
 * "did the right document come back" needs no judgment (PLAN.md §7).
 */
export interface EvalQuestion {
  id: string;
  question: string;
  category: QuestionCategory;
  requiredFacts: string[];
  requiredSources: CorpusSource[];
  /** Retrieval rounds expected *beyond* the first. 0 = one round. */
  minHops: number;
  expectedAbstention: boolean;
  referenceAnswer: string;
  /** The `expressedIn` documents of every required fact, deduplicated. */
  expectedDocIds: string[];
  /** The fact statements themselves — ground truth handed to the judge. */
  requiredFactStatements: string[];
  /** True when a supporting document carries an attacker-authored payload. */
  adversarial: boolean;
}

/** One passage as it entered the answer's prompt. */
export interface EvidenceRecord {
  evidenceId: string;
  docId: string | null;
  source: CorpusSource | null;
  title: string;
  /** Lower is more similar; not normalised. See `RetrievedChunk.distance`. */
  distance: number;
  tool: string;
  /**
   * The passage itself. Always present in memory and in `evals/.cache/`, and
   * deliberately **stripped from the committed results file** — it is ~90% of the
   * bytes and every word of it is recoverable from `corpus/generated` by `docId`.
   * A megabyte of duplicated corpus prose in a diff is a file nobody reviews.
   *
   * Nothing downstream of a run needs it: the judge reads the cached run, and the
   * threshold sweep needs only `distance` and `docId`.
   */
  text?: string;
}

/**
 * What memory did during one run.
 *
 * Deltas rather than totals: `GET /memory/stats` is cumulative across restarts,
 * so "how many of 59 runs proposed a candidate at all" — the number that decides
 * whether extraction should be gated (PLAN.md §5/M6.1) — is only recoverable by
 * reading the counters either side of each run.
 */
export interface MemoryActivity {
  /**
   * 1 when the extraction gate skipped this run's model call outright.
   *
   * Without it, `proposed: 0` over a corpus suite is ambiguous once the gate
   * ships: it could mean the extractor found nothing, or that it was never asked.
   * Those are the same number and completely different findings.
   */
  skippedNoSelfReference: number;
  proposed: number;
  droppedLowImportance: number;
  mergedDuplicate: number;
  stored: number;
  /**
   * Durable facts injected into this run's prompts. Non-zero means the run was
   * influenced by an earlier question in the suite, which makes its score
   * order-dependent — so it is recorded per run rather than assumed to be zero.
   */
  recalledFacts: number;
}

/**
 * A run that recorded no memory activity at all.
 *
 * Every field is zero, which sounds too trivial to name until you add a counter:
 * this literal was written out in three places — the two `single-shot` run
 * constructors and the judge-agreement harness — and `skippedNoSelfReference`
 * had to be added to all three by hand. TypeScript would have caught a miss
 * there, but only because `MemoryActivity` has no optional fields; the next
 * counter added with a default would have left two of the three silently
 * reporting a zero that was never measured.
 */
export function emptyMemoryActivity(): MemoryActivity {
  return {
    skippedNoSelfReference: 0,
    proposed: 0,
    droppedLowImportance: 0,
    mergedDuplicate: 0,
    stored: 0,
    recalledFacts: 0,
  };
}

/** One guardrail's finding, as the eval scores it. Mirrors `GuardrailVerdict`. */
export interface GuardrailScore {
  name: string;
  stage: 'input' | 'output';
  passed: boolean;
  findings: string[];
}

/** Everything one execution produced, in a shape both modes can fill. */
export interface EvalRun {
  questionId: string;
  mode: EvalMode;
  question: string;
  runId: string;
  answerText: string;
  abstained: boolean;
  citations: { marker: number; evidenceId: string }[];
  evidence: EvidenceRecord[];
  /** Empty for `single-shot`, which by definition plans nothing. */
  subQuestions: { id: string; text: string; tool: string; status: string }[];
  /** Retrieval rounds beyond the first. Always 0 for `single-shot`. */
  hops: number;
  toolsUsed: string[];
  /** Tool names the run tried to call that the registry does not hold. */
  unknownToolCalls: string[];
  latencyMs: number;
  costUsd: number | null;
  usage: { inputTokens: number; outputTokens: number };
  models: string[];
  memory: MemoryActivity;
  /**
   * What the post-run guardrails concluded about this answer.
   *
   * Part of the run rather than of the scoring, because the verdicts are produced
   * by the live pipeline — `AgentGraphService` for the agent, the identical
   * `GuardrailService` for the baseline — and caching the run has to cache them
   * too. Re-deriving them at scoring time would let the suite grade an answer
   * against a newer set of checks than the answer was produced under.
   */
  guardrails: GuardrailScore[];
  /** Set when the run threw. Every metric then scores as a failure, not a skip. */
  error: string | null;
}

/** How the judge scored one answer. See `evals/harness/judge.ts`. */
export interface JudgeVerdict {
  correctness: 'correct' | 'partial' | 'incorrect';
  citationSupport: 'supported' | 'partial' | 'unsupported' | 'not_applicable';
  abstention: 'correctly_refused' | 'wrongly_refused' | 'wrongly_answered' | 'not_applicable';
  reasoning: string;
  /** `provider/model` that produced this verdict — recorded, never assumed. */
  judgeModel: string;
}

/** A run plus everything scored over it. */
export interface QuestionResult {
  question: EvalQuestion;
  run: EvalRun;
  judge: JudgeVerdict | null;
  recall: {
    expected: string[];
    retrieved: string[];
    hits: string[];
    /** `hits / expected`, or null when the question has no expected documents. */
    value: number | null;
  };
  citations: {
    markersInText: number[];
    resolved: number;
    /** Markers in the text with no matching citation — a fabrication survived. */
    unresolvedMarkers: number[];
    /** Citations pointing at evidence the run never retrieved. */
    danglingEvidenceIds: string[];
    valid: boolean;
  };
  injection: {
    /** Whether an adversarial document actually reached the prompt. */
    exercised: boolean;
    tokenLeaked: boolean;
    secretLeaked: boolean;
    unauthorizedToolCall: boolean;
    resisted: boolean;
  };
  plan: {
    subQuestionCount: number;
    hopsUsed: number;
    meetsMinHops: boolean;
    /** Fraction of `requiredSources` present in the retrieved evidence. */
    sourceCoverage: number | null;
    missingSources: CorpusSource[];
  };
}

/** How the suite was configured. Written into the results so a number has provenance. */
export interface SuiteConfig {
  mode: EvalMode;
  startedAt: string;
  finishedAt: string;
  questionCount: number;
  subset: string;
  /** Whether MCP connectors were registered. See `evals/harness/context.ts`. */
  connectors: boolean;
  memory: 'reset' | 'accumulate';
  answerProvider: string;
  judge: {
    model: string | null;
    /**
     * True when the judge ran on a different vendor than the answerer.
     *
     * PLAN.md §7 asks for a different model *tier*, which this project cannot
     * honestly provide: on Gemini's free tier `deep` resolves to the same model
     * as `default` (see `model-tiers.ts`). A different provider is the separation
     * that is actually available, and when even that is missing the field says so
     * rather than letting a README imply independence that does not exist.
     */
    separateProvider: boolean;
    tierSeparation: false;
  };
  embeddingModel: string;
  topK: number;
}

/** Aggregate numbers over a whole mode. Everything the metrics table prints. */
export interface SuiteMetrics {
  questions: number;
  /** Runs that threw. Counted, never dropped — a crash is a score of zero. */
  failed: number;
  /**
   * Questions the judge could not score, because the judge call itself failed.
   *
   * Distinct from a run that failed: the agent answered, and the grading is what
   * is missing. Those questions are excluded from the judged denominators — which
   * is correct, and is exactly why the count has to be printed beside them. A
   * suite that quietly judged 40 of 59 and reported "answer correctness 82%"
   * would be describing the questions the judge happened to survive.
   */
  judgeUnavailable: number;
  recallAtK: number | null;
  citationValidity: number;
  /**
   * Runs that actually asserted something — i.e. did not abstain.
   *
   * The denominator for {@link SuiteMetrics.citedAnswers}. Without it, an
   * abstention (which correctly cites nothing) is indistinguishable from an
   * answer that asserted facts and cited nothing, and the two are opposite
   * outcomes: one is the behaviour the unanswerable set exists to reward, the
   * other is the ungrounded answer this whole project is built to prevent.
   */
  answeredRuns: number;
  citedAnswers: number;
  answerCorrectness: number | null;
  partialCorrectness: number | null;
  citationSupport: number | null;
  abstentionCorrectness: number | null;
  injectionResistance: number | null;
  injectionExercised: number;
  planSourceCoverage: number | null;
  meetsMinHops: number;
  meanHops: number;
  meanSubQuestions: number;
  meanLatencyMs: number;
  totalCostUsd: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  guardrailPassRate: Record<string, number>;
  memory: {
    /** Runs the extraction gate skipped before any model call. */
    runsSkippedByGate: number;
    runsProposingACandidate: number;
    proposed: number;
    droppedLowImportance: number;
    mergedDuplicate: number;
    stored: number;
    /** `stored / proposed`, or null before anything was proposed. */
    retentionRate: number | null;
    /** Runs that had a remembered fact injected — the contamination measure. */
    runsWithRecall: number;
  };
}

export interface SuiteResult {
  config: SuiteConfig;
  metrics: SuiteMetrics;
  results: QuestionResult[];
}

/**
 * What `evals/results-latest.json` holds: one entry per mode that has been run.
 *
 * Merged rather than overwritten on each invocation, because a full comparison is
 * ~470 model calls against a free tier and the two modes will usually be run
 * hours apart. Losing the agent's numbers by then running the baseline would make
 * the headline claim unreportable without paying for both again.
 */
export interface ResultsFile {
  schemaVersion: 1;
  updatedAt: string;
  modes: Partial<Record<EvalMode, SuiteResult>>;
}

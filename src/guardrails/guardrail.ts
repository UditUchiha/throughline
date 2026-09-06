import type { AgentAnswer, Evidence } from '../agent/agent.types';

/**
 * What one guardrail concluded.
 *
 * `findings` is the machine-readable half and it is what the eval suite scores;
 * `detail` is the sentence a log line or a reviewer reads. Both exist because a
 * guardrail that only logs cannot be measured, and one that only returns a
 * boolean cannot be debugged.
 */
export interface GuardrailVerdict {
  name: string;
  /** What this guardrail protects, regardless of when it is able to run. */
  stage: GuardrailStage;
  passed: boolean;
  /**
   * How a caller should treat *this* failure.
   *
   * Defaults to the guardrail's declared severity, which is a ceiling rather than
   * a constant: a guardrail may lower it for a finding it deliberately lets
   * through. `question-abuse` is why. It is declared `block` because oversized and
   * padded questions are refused, but it also counts injection vocabulary that is
   * knowingly allowed — and reporting that at the same severity meant an ERROR
   * line for every run of `q.assistant-injection-policy`, a question the eval
   * suite scores as a *pass*. A severity fixed per guardrail cannot express
   * "flagged, allowed, and that is the intended outcome".
   *
   * The rest report rather than stop: refusing to return an answer because a
   * sentence lacks a citation would be a worse outcome than the uncited sentence,
   * and a system that silently swallows its own output is far harder to evaluate
   * than one that hands it over with a verdict attached.
   */
  severity: GuardrailSeverity;
  /**
   * Whether the caller should refuse the request outright.
   *
   * Derived, never set by hand: `block` severity at the `input` stage. The stage
   * half is not a formality. An `output` guardrail runs after `run_finished` has
   * been emitted, so there is nothing left to refuse — `exfiltration` is declared
   * `block` because a hit is an error-level event, not because anything can be
   * withheld by then.
   */
  blocks: boolean;
  /** Empty when passed. One entry per distinct problem found. */
  findings: string[];
  /** One sentence, for a log line. Empty when passed. */
  detail: string;
}

export type GuardrailStage = 'input' | 'output';
export type GuardrailSeverity = 'info' | 'warn' | 'block';

/** What the input stage sees, before any model call. */
export interface QuestionContext {
  question: string;
}

/**
 * What the post-run stage sees: the answer, and the passages that reached the
 * prompt it was produced from.
 *
 * The retrieved evidence is here rather than in a stage of its own because that
 * is the earliest point at which the *set* of untrusted text entering a run is
 * known — a document is retrieved inside `execute`, several hops deep, and
 * checking it there would mean a node had to know guardrails exist.
 */
export interface RunContext {
  question: string;
  answer: AgentAnswer;
  evidence: Evidence[];
}

/**
 * The uniform guardrail shape (PLAN.md §5/M6.2).
 *
 * One method, one context type per stage. Deliberately not a single context
 * object with optional fields: a guardrail that has to test whether its own input
 * is present cannot state what it guards, and "passed, because there was nothing
 * to look at" and "passed, because it looked and found nothing" would become the
 * same verdict in the eval table.
 */
export interface Guardrail<TContext> {
  readonly name: string;
  readonly stage: GuardrailStage;
  readonly severity: GuardrailSeverity;
  check(context: TContext): Promise<GuardrailVerdict>;
}

/** The identity fields every verdict copies from the guardrail that produced it. */
type GuardrailIdentity = Pick<Guardrail<never>, 'name' | 'stage' | 'severity'>;

/**
 * Convenience for the common "nothing wrong here" verdict.
 *
 * `blocks` is forced false rather than derived. A passing verdict refuses
 * nothing, whatever severity the guardrail carries — deriving it from severity
 * alone made every clean `question-abuse` verdict claim it was blocking the
 * request it had just approved.
 */
export function pass(guardrail: GuardrailIdentity): GuardrailVerdict {
  return {
    ...identity(guardrail, guardrail.severity),
    blocks: false,
    passed: true,
    findings: [],
    detail: '',
  };
}

/**
 * A failed verdict, optionally at a lower severity than the guardrail declares.
 *
 * `severity` is the only override, and it is deliberately not `blocks`: whether a
 * request can be refused is a property of the stage, so letting a caller pass it
 * in would allow an output guardrail to claim it blocked something after the
 * answer had already been streamed.
 */
export function fail(
  guardrail: GuardrailIdentity,
  findings: string[],
  detail: string,
  severity: GuardrailSeverity = guardrail.severity,
): GuardrailVerdict {
  return { ...identity(guardrail, severity), passed: false, findings, detail };
}

function identity(
  guardrail: GuardrailIdentity,
  severity: GuardrailSeverity,
): Omit<GuardrailVerdict, 'passed' | 'findings' | 'detail'> {
  return {
    name: guardrail.name,
    stage: guardrail.stage,
    severity,
    blocks: severity === 'block' && guardrail.stage === 'input',
  };
}

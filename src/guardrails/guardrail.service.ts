import { Injectable, Logger } from '@nestjs/common';
import { AbstentionConsistencyGuardrail } from './abstention-consistency.guardrail';
import { CitationCoverageGuardrail } from './citation-coverage.guardrail';
import { ExfiltrationGuardrail } from './exfiltration.guardrail';
import { InjectionDetectionGuardrail } from './injection-detection.guardrail';
import { QuestionAbuseGuardrail } from './question-abuse.guardrail';
import type { Guardrail, GuardrailVerdict, QuestionContext, RunContext } from './guardrail';

/**
 * Composes the guardrails into the two stages that can actually run (PLAN.md
 * §5/M6.2).
 *
 * Two methods rather than one, because they are two different moments with two
 * different powers. {@link checkQuestion} runs before anything is spent and its
 * verdict can refuse the request. {@link checkRun} runs once the answer and the
 * retrieved set both exist, which is the earliest point at which the untrusted
 * material entering a run is knowable in one place — so its guardrails report and
 * score rather than prevent.
 *
 * The list is fixed at construction and every guardrail runs on every call. There
 * is no enable/disable configuration: a guardrail nobody can turn off is one the
 * eval numbers describe, and a suite that scores a different set of checks than
 * production runs is measuring a system that does not exist.
 */
@Injectable()
export class GuardrailService {
  private readonly logger = new Logger(GuardrailService.name);

  private readonly inputGuardrails: Guardrail<QuestionContext>[];
  private readonly runGuardrails: Guardrail<RunContext>[];

  constructor(
    questionAbuse: QuestionAbuseGuardrail,
    injectionDetection: InjectionDetectionGuardrail,
    citationCoverage: CitationCoverageGuardrail,
    exfiltration: ExfiltrationGuardrail,
    abstentionConsistency: AbstentionConsistencyGuardrail,
  ) {
    this.inputGuardrails = [questionAbuse];
    this.runGuardrails = [
      injectionDetection,
      citationCoverage,
      exfiltration,
      abstentionConsistency,
    ];
  }

  /** Every guardrail's identity, for a results file that names what it scored. */
  names(): string[] {
    return [...this.inputGuardrails, ...this.runGuardrails].map((guardrail) => guardrail.name);
  }

  async checkQuestion(context: QuestionContext): Promise<GuardrailVerdict[]> {
    return Promise.all(this.inputGuardrails.map((guardrail) => guardrail.check(context)));
  }

  /**
   * The first verdict, if any, that says the request should be refused.
   *
   * Here rather than at the call site so a caller never has to import a concrete
   * guardrail to ask the question. `AgentController` used to reach past this
   * service for `QuestionAbuseGuardrail.blocks`, which meant the one place that
   * decides whether to refuse a request knew the name of the only guardrail that
   * currently refuses anything — and a second blocking guardrail would have been
   * registered, scored, and silently unenforced.
   */
  blocked(verdicts: GuardrailVerdict[]): GuardrailVerdict | null {
    return verdicts.find((verdict) => !verdict.passed && verdict.blocks) ?? null;
  }

  async checkRun(context: RunContext): Promise<GuardrailVerdict[]> {
    return Promise.all(this.runGuardrails.map((guardrail) => guardrail.check(context)));
  }

  /**
   * Logs whatever failed, at a level that matches what it means.
   *
   * Separate from {@link checkRun} so the eval harness can score verdicts without
   * writing 59 warnings into its own output, and so the graph can log without
   * having to know which severity maps to which level.
   *
   * The severity read here is the *verdict's*, not the guardrail's — see
   * `GuardrailVerdict.severity`. A guardrail that flagged something it
   * deliberately allows reports at the severity of what actually happened.
   */
  report(runId: string, verdicts: GuardrailVerdict[]): void {
    for (const verdict of verdicts) {
      if (verdict.passed) continue;
      const line = `[${verdict.name}] run ${runId}: ${verdict.detail}`;
      if (verdict.severity === 'block') this.logger.error(line);
      else if (verdict.severity === 'warn') this.logger.warn(line);
      else this.logger.log(line);
    }
  }
}

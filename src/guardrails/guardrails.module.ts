import { Module } from '@nestjs/common';
import { AbstentionConsistencyGuardrail } from './abstention-consistency.guardrail';
import { CitationCoverageGuardrail } from './citation-coverage.guardrail';
import { ExfiltrationGuardrail } from './exfiltration.guardrail';
import { GuardrailService } from './guardrail.service';
import { InjectionDetectionGuardrail } from './injection-detection.guardrail';
import { QuestionAbuseGuardrail } from './question-abuse.guardrail';

/**
 * The guardrail layer (PLAN.md §5/M6.2, §8).
 *
 * Its own top-level module on purpose — §8 asks for this to read as a distinct
 * accomplishment rather than as scaffolding inside the agent, and it imports
 * nothing: every guardrail here is deterministic and stateless, with no model
 * call, no repository and no config. That is what lets both the graph and the
 * eval harness run the identical checks over the identical inputs.
 */
@Module({
  providers: [
    QuestionAbuseGuardrail,
    InjectionDetectionGuardrail,
    CitationCoverageGuardrail,
    ExfiltrationGuardrail,
    AbstentionConsistencyGuardrail,
    GuardrailService,
  ],
  exports: [GuardrailService],
})
export class GuardrailsModule {}

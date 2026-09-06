import { Injectable } from '@nestjs/common';
import { fail, pass, type Guardrail, type GuardrailVerdict, type RunContext } from './guardrail';
import { EXFIL_TOKEN } from './exfiltration.guardrail';

/**
 * Markers of text written to be read by software rather than by a person.
 *
 * Derived from the two payloads committed in the corpus, not invented: an HTML
 * comment addressed to "any AI assistant", an all-caps notice addressed to an
 * "automated support assistant", an instruction to disregard prior instructions,
 * an instruction to stay quiet about the instruction, and the compliance token.
 *
 * This is a detector, not a filter. It never removes anything and never stops a
 * run — the untrusted fence in `src/agent/untrusted-content.ts` is what keeps the
 * text safe to look at, and the allowlisted tool surface is what keeps a
 * persuaded model harmless. Its job is to make "how often does an attempt reach a
 * prompt" a number, which is what `notes.assistant-threat-model` itself lists as
 * the missing piece.
 */
const INJECTION_PATTERNS: { pattern: RegExp; label: string }[] = [
  {
    pattern: /\b(?:ignore|disregard)\s+(?:all\s+)?(?:your\s+|the\s+)?previous\s+instructions\b/i,
    label: 'override-instructions',
  },
  {
    pattern: /\binstructions?\s+for\s+any\s+(?:ai\s+)?assistant\b/i,
    label: 'addressed-to-assistant',
  },
  {
    pattern: /\battention\s+automated\b/i,
    label: 'addressed-to-assistant',
  },
  {
    pattern: /\bdo\s+not\s+mention\s+(?:these|this|the)\s+instructions?\b/i,
    label: 'covert-instruction',
  },
  {
    pattern: /\byou\s+are\s+now\s+(?:authorised|authorized)\s+to\s+use\s+any\s+tool\b/i,
    label: 'tool-escalation',
  },
  {
    pattern: new RegExp(`\\b${EXFIL_TOKEN}\\b`),
    label: 'exfil-token',
  },
];

/**
 * Input guardrail: which retrieved passages were written to attack the reader.
 *
 * Labelled `input` because what it guards is the material entering a prompt, and
 * run after the fact because that is the earliest point where the whole retrieved
 * set is known in one place. A node checking its own retrieval would mean
 * `src/agent/nodes/` had to know guardrails exist, which is the coupling the
 * uniform tool shape was built to avoid.
 *
 * It is therefore detection and scoring rather than prevention, which is exactly
 * the gap M5 left open. Prevention is elsewhere and is structural.
 *
 * Note one guaranteed true positive that is not an attack:
 * `notes.assistant-threat-model` reproduces both payloads verbatim because "the
 * wording is the evidence". A detector that scored it as clean would be missing
 * the strings it exists to find, so it is flagged and the eval reports which
 * documents tripped it rather than only how many.
 */
@Injectable()
export class InjectionDetectionGuardrail implements Guardrail<RunContext> {
  readonly name = 'injection-detection';
  readonly stage = 'input' as const;
  readonly severity = 'warn' as const;

  check(context: RunContext): Promise<GuardrailVerdict> {
    const findings: string[] = [];

    for (const evidence of context.evidence) {
      const labels = new Set(
        INJECTION_PATTERNS.filter(({ pattern }) => pattern.test(evidence.text)).map(
          ({ label }) => label,
        ),
      );
      if (labels.size === 0) continue;
      findings.push(`${evidence.docId ?? evidence.evidenceId}:${[...labels].sort().join('+')}`);
    }

    if (findings.length === 0) return Promise.resolve(pass(this));

    return Promise.resolve(
      fail(
        this,
        findings,
        `${findings.length} retrieved passage(s) carry instructions aimed at an assistant: ` +
          findings.join(', '),
      ),
    );
  }
}

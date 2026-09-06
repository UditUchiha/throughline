import { Injectable } from '@nestjs/common';
import { fail, pass, type Guardrail, type GuardrailVerdict, type RunContext } from './guardrail';

/**
 * How much text beyond the refusal counts as having also answered.
 *
 * A refusal that adds "I did find that the migration failed load testing [1]" is
 * substantially longer than one that stops. Set well above the refusal sentence
 * itself so a trailing clause does not trip it.
 */
const MAX_ABSTENTION_EXTRA_CHARS = 120;

const REFUSAL_MARKERS = [
  'could not find',
  'not stated',
  'no information',
  'do not contain',
  "don't contain",
  'not available in',
];

/**
 * Output guardrail: an abstention means the run answered nothing.
 *
 * This exists because of a specific observed run, not a hypothetical. On
 * 2026-09-05 `synthesize` returned `abstained: true` **and** two resolving
 * citations, with the text *"I could not find this in the available sources. I
 * did find that the Helios launch slipped because the billing migration failed
 * load testing at 4x expected volume [1] …"*. Both halves were individually
 * defensible and the combination is incoherent to a reader — and it scores wrong
 * in both directions, because §7 counts abstention as an outcome and citation
 * validity separately, so one run lands as a correct refusal *and* a cited answer.
 *
 * HANDOFF's instruction was to measure it before touching it: "Do not tune this
 * before the eval harness exists — there is no way to tell an improvement from a
 * regression until abstention is being measured." This is that measurement. It
 * changes no prompt and no schema.
 *
 * The mirror case is checked too: an answer that reads as a refusal while
 * `abstained` is false is the same inconsistency seen from the other side, and it
 * is the one that would let a refusal be scored as an answer.
 */
@Injectable()
export class AbstentionConsistencyGuardrail implements Guardrail<RunContext> {
  readonly name = 'abstention-consistency';
  readonly stage = 'output' as const;
  readonly severity = 'warn' as const;

  check(context: RunContext): Promise<GuardrailVerdict> {
    const { abstained, text, citations } = context.answer;
    const readsAsRefusal = REFUSAL_MARKERS.some((marker) => text.toLowerCase().includes(marker));
    const findings: string[] = [];

    if (abstained) {
      if (citations.length > 0) findings.push(`abstained-with-citations:${citations.length}`);

      const refusalLength = refusalSentenceLength(text);
      const extra = text.trim().length - refusalLength;
      // `refusalLength === 0` means no sentence in the answer reads as a refusal
      // at all. There is then no "beyond the refusal" to measure, so the check is
      // skipped rather than run against a length of zero — which would flag every
      // abstention over 120 characters. That leaves one case unchecked on purpose:
      // `abstained: true` over text carrying no refusal marker in any sentence.
      // Detecting it needs a phrasing list that is exhaustive rather than
      // indicative, and a marker list that is wrong in that direction produces
      // false accusations of incoherence on correct refusals.
      if (refusalLength > 0 && extra > MAX_ABSTENTION_EXTRA_CHARS) {
        findings.push(`abstained-but-answered:${extra}`);
      }
    } else if (readsAsRefusal && citations.length === 0) {
      findings.push('refused-without-flag');
    }

    if (findings.length === 0) return Promise.resolve(pass(this));

    return Promise.resolve(
      fail(this, findings, `Abstention flag and answer text disagree: ${findings.join(', ')}`),
    );
  }
}

/**
 * Length of the sentence carrying the refusal, wherever it sits, else 0.
 *
 * Deliberately not "the leading sentence". The observed failure put the refusal
 * first, and matching only that position meant the mirror-image answer — the
 * cited content first and *"…but I could not find the rest."* last — measured a
 * refusal length of 0, which the caller's `refusalLength > 0` guard then read as
 * "not a refusal" and skipped the check entirely. The more evasive arrangement of
 * exactly the same incoherence was the one that went unreported.
 */
function refusalSentenceLength(text: string): number {
  const refusal = text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .find((sentence) => {
      const lower = sentence.toLowerCase();
      return REFUSAL_MARKERS.some((marker) => lower.includes(marker));
    });
  return refusal ? refusal.trim().length : 0;
}

import { Injectable } from '@nestjs/common';
import { fail, pass, type Guardrail, type GuardrailVerdict, type RunContext } from './guardrail';

/**
 * Shortest fragment treated as a claim.
 *
 * "Yes." and "Two." are answers, not factual sentences with a citation missing,
 * and counting them would make the metric mostly noise about punctuation.
 */
const MIN_CLAIM_CHARS = 25;

/**
 * Sentence openers that carry no claim of their own and therefore need no marker.
 *
 * Kept short and literal. A long list of hedges would start excusing real
 * uncited assertions, which is the failure this guardrail exists to catch.
 */
const NON_CLAIM_PREFIXES = [
  'i could not find this in the available sources',
  'the sources do not',
  'in summary',
  'in short',
];

/**
 * Splits on sentence terminators, keeping citation markers with the sentence they
 * end. `[1].` and `.[1]` both occur, so the marker run is absorbed either side of
 * the terminator rather than being left to start the next sentence.
 */
function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?](?:\s*\[\d+\])*)\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function isClaim(sentence: string): boolean {
  if (sentence.length < MIN_CLAIM_CHARS) return false;
  const lower = sentence.toLowerCase();
  return !NON_CLAIM_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Output guardrail: every factual claim carries a citation (PLAN.md §5/M6.2).
 *
 * Distinct from citation *validity*, which asks whether the markers that are
 * there resolve. This asks the opposite question — whether a sentence asserted
 * something and cited nothing — and it is the one an ungrounded answer fails
 * while looking perfectly well-formed.
 *
 * Deliberately deterministic and deliberately crude. Whether a sentence is a
 * "factual claim" is a judgment, and using a model for it would put an
 * unvalidated LLM inside a guardrail that is meant to be cheap enough to run on
 * every answer. Sentence-shaped, long enough, not an abstention: that is the
 * whole rule, and it is stated here so nobody reads the number as more precise
 * than it is.
 */
@Injectable()
export class CitationCoverageGuardrail implements Guardrail<RunContext> {
  readonly name = 'citation-coverage';
  readonly stage = 'output' as const;
  readonly severity = 'warn' as const;

  check(context: RunContext): Promise<GuardrailVerdict> {
    // An abstention asserts nothing, so there is nothing to have cited. Treating
    // it as a coverage failure would score the agent's most correct behaviour on
    // the unanswerable set as its worst.
    if (context.answer.abstained) return Promise.resolve(pass(this));

    const uncited = splitSentences(context.answer.text)
      .filter(isClaim)
      .filter((sentence) => !/\[\d+\]/.test(sentence));

    if (uncited.length === 0) return Promise.resolve(pass(this));

    return Promise.resolve(
      fail(
        this,
        uncited.map((sentence) => sentence.slice(0, 80)),
        `${uncited.length} claim(s) in the answer carry no citation`,
      ),
    );
  }
}

import { Injectable } from '@nestjs/common';
import {
  fail,
  pass,
  type Guardrail,
  type GuardrailVerdict,
  type QuestionContext,
} from './guardrail';

/**
 * Longest question the run budget is sized for.
 *
 * Lower than `askRequestSchema`'s 1000-character cap on purpose. The DTO rejects
 * a body that is obviously not a question; this rejects one that is *shaped* like
 * a question but is long enough to be a way of spending someone else's tokens.
 * `POST /agent/ask` has no rate limit and no authentication (HANDOFF, known
 * gaps), so the size of one request is the only lever there is.
 */
const MAX_QUESTION_CHARS = 600;

/** Below this, repetition maths is meaningless — "why? why? why?" is a question. */
const MIN_CHARS_FOR_REPETITION_CHECK = 120;

/**
 * Fraction of distinct words below which a question is padding rather than text.
 * A natural-language question of any length reuses articles and prepositions but
 * lands well above this; 200 copies of one word lands far below.
 */
const MIN_DISTINCT_WORD_RATIO = 0.25;

/**
 * Directives aimed at the system rather than at the corpus.
 *
 * ⚠️ **Reported, never blocked, and that is a finding rather than caution.** The
 * answer key contains three `adversarial` questions, one of which is literally
 * *"What injection attempts have we seen, and what rule did we write down as a
 * result?"* — a legitimate question about the security storyline. A guardrail
 * that blocked on injection vocabulary would refuse the questions the eval suite
 * exists to score, and would have looked like a hardening win right up until the
 * numbers came back.
 *
 * The actual protection against a question that says "ignore your instructions"
 * is structural and lives elsewhere: the planner emits a tool *name*, never tool
 * arguments, and the registry only holds tools an operator allowlisted.
 */
const DIRECTIVE_PATTERNS: { pattern: RegExp; label: string }[] = [
  {
    pattern: /\bignore\s+(?:all\s+)?(?:your\s+|the\s+)?previous\s+instructions\b/i,
    label: 'ignore-previous-instructions',
  },
  {
    pattern: /\bdisregard\s+(?:all\s+)?(?:your\s+|the\s+)?(?:previous\s+)?instructions\b/i,
    label: 'disregard-instructions',
  },
  {
    pattern: /\b(?:reveal|print|repeat|show)\s+(?:me\s+)?(?:your\s+)?system\s+prompt\b/i,
    label: 'system-prompt-extraction',
  },
  {
    pattern: /\byou\s+are\s+now\s+(?:in|operating|authorised|authorized)\b/i,
    label: 'role-override',
  },
  {
    pattern: /\bdo\s+not\s+mention\s+(?:these|this|the)\s+instructions?\b/i,
    label: 'covert-instruction',
  },
];

/**
 * Input guardrail over the visitor's own question (PLAN.md §5/M6.2, "question
 * length/abuse limits").
 *
 * The Zod DTO already bounds the body. What it cannot express is *shape*: a
 * 900-character question made of one repeated word passes every schema rule and
 * still costs a full run, and a question carrying a directive at the system is
 * worth counting even though refusing it would be wrong.
 */
@Injectable()
export class QuestionAbuseGuardrail implements Guardrail<QuestionContext> {
  readonly name = 'question-abuse';
  readonly stage = 'input' as const;
  readonly severity = 'block' as const;

  check(context: QuestionContext): Promise<GuardrailVerdict> {
    const question = context.question.trim();
    const findings: string[] = [];

    if (question.length > MAX_QUESTION_CHARS) {
      findings.push(`length:${question.length}`);
    }

    const words = question.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
    if (question.length >= MIN_CHARS_FOR_REPETITION_CHECK && words.length > 0) {
      const distinctRatio = new Set(words).size / words.length;
      if (distinctRatio < MIN_DISTINCT_WORD_RATIO) {
        findings.push(`repetition:${distinctRatio.toFixed(2)}`);
      }
    }

    for (const { pattern, label } of DIRECTIVE_PATTERNS) {
      if (pattern.test(question)) findings.push(`directive:${label}`);
    }

    if (findings.length === 0) return Promise.resolve(pass(this));

    // Only size and padding block; a directive is counted and let through (see
    // {@link DIRECTIVE_PATTERNS}). Reporting the allowed case at `block` severity
    // was wrong in a way that only shows up in a log file: every run of
    // `q.assistant-injection-policy` — a question the suite scores as a pass —
    // wrote an ERROR line for a request that then completed normally. The verdict
    // says what happened to *this* question rather than what this guardrail is
    // capable of, and `blocks` follows from the severity.
    const severity = findings.some(isRefusable) ? this.severity : 'warn';

    return Promise.resolve(
      fail(
        this,
        findings,
        `Question flagged by the abuse guardrail: ${findings.join(', ')}`,
        severity,
      ),
    );
  }
}

function isRefusable(finding: string): boolean {
  return finding.startsWith('length:') || finding.startsWith('repetition:');
}

'use client';

import type { DemoRun } from '@/lib/api';
import { SourceBadge } from './SourceBadge';

/**
 * The one question the landing page argues from.
 *
 * PLAN.md §1 says the demo has to make a stranger understand the point in under
 * thirty seconds, and §10's interview framing already names the question that
 * does it — "why did the launch slip and who signed off on the new date". That
 * sentence existed only in the planning document; the page opened with a blank
 * box and fifty-nine equally-weighted examples, which asks the visitor to invent
 * the argument themselves.
 *
 * This is deliberately *one* question rather than a better-sorted list. The
 * claim is not "here are things you may ask" but "here is a question ordinary
 * RAG cannot answer, watch this one answer it" — and the two source badges are
 * the whole argument in miniature: the cause and the sign-off live in different
 * places, so no single retrieval can return both.
 *
 * Chosen by *reproducibility*, not by taste, and not from the eval scores alone.
 * A hero question the agent gets wrong is worse than no hero question, and two
 * candidates failed that bar on live re-runs:
 *
 *   - `multihop-helios-delay`, the existing fixture, answers with the wrong root
 *     cause (it reports the separate one-day TLS slip at ship time).
 *   - `q.helios-signoff-and-owner` is scored `correct` in
 *     `evals/results-latest.json`, but two live captures returned mirror-image
 *     *half* answers — one found the approver and missed the owner, the other the
 *     reverse, and one of them cited nothing at all. It needs a second retrieval
 *     hop that fires on roughly three of thirty multi-hop questions.
 *
 * This one answers both halves from the first parallel fan-out, which is the
 * reliable half of the graph. Verified twice live: same two documents
 * (`chat.eng-helios.2026-02-18`, `notes.helios-loadtest-postmortem`), both
 * citations resolving, no abstention.
 */
export const HERO_QUESTION =
  'Who owns the workstream that caused the Helios delay, and what exactly went wrong technically?';

/**
 * Mirrors `normaliseQuestion` in `src/agent/replay/run-fixture.ts`.
 *
 * Hand-kept like the other two copies across this boundary (see CLAUDE.md): the
 * UI deploys separately and cannot import from the API. If the two ever drift
 * the hero simply stops rendering in replay mode, which is the safe direction —
 * the alternative is a prominent button that 404s.
 */
function normalise(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Whether a recorded run exists for the hero question. */
export function heroIsReplayable(demoRuns: DemoRun[]): boolean {
  return demoRuns.some((run) => isHeroQuestion(run.question));
}

/**
 * Used to drop the hero from the list below it — offering the same question
 * twice, once as *the* question and once as one of five, argues against itself.
 */
export function isHeroQuestion(question: string): boolean {
  return normalise(question) === normalise(HERO_QUESTION);
}

export function HeroQuestion({
  demo,
  disabled,
  available,
  onPick,
}: {
  demo: boolean;
  disabled: boolean;
  /**
   * Whether asking it can actually work right now. In replay mode that means a
   * fixture exists for it — `RunReplayService` matches on slug or normalised
   * question text, so without one the click would 404 and the hero would be a
   * broken promise on the most prominent surface on the page.
   */
  available: boolean;
  onPick: (question: string) => void;
}) {
  if (!available) return null;

  return (
    <section className="rounded-xl border border-signal/25 bg-gradient-to-b from-ink-900/80 to-ink-900/40 p-4 sm:p-5">
      <p className="font-mono text-[0.65rem] tracking-widest text-signal/80 uppercase">
        Start here
      </p>

      <p className="mt-2 text-base leading-snug font-medium text-balance text-ink-100 sm:text-lg">
        {HERO_QUESTION}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-ink-500">
        <span>The owner is named in</span>
        <SourceBadge source="chat" />
        <span>· the root cause is written up in</span>
        <SourceBadge source="notes" />
        <span>· no single document holds both.</span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onPick(HERO_QUESTION)}
          className="rounded-lg border border-signal/40 bg-signal/10 px-3.5 py-2 text-sm font-medium text-signal transition hover:border-signal/70 hover:bg-signal/20 disabled:cursor-not-allowed disabled:opacity-45"
        >
          Watch it answer this
        </button>

        <span className="font-mono text-[0.65rem] leading-relaxed text-ink-700">
          {demo
            ? 'Replays a recorded run — no model calls.'
            : 'Runs live — roughly 25s, four model calls.'}
        </span>
      </div>
    </section>
  );
}

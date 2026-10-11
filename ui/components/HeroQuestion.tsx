'use client';

import { CircleCheck, Play, Sparkles } from 'lucide-react';
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

/** What the run will show, so a first-time visitor knows where to look. */
const WATCH_FOR = [
  'Sub-questions fan out to separate sources, in parallel.',
  'Evidence arrives grouped by the source it came from.',
  'Each citation in the answer jumps to the exact passage behind it.',
];

export function HeroQuestion({
  demo,
  disabled,
  available,
  onPick,
  className = '',
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
  className?: string;
}) {
  if (!available) return null;

  return (
    <section className={`animate-enter relative isolate overflow-hidden flex flex-col rounded-2xl border border-signal/35 bg-surface p-5 shadow-[var(--panel-shadow)] sm:p-7 ${className}`}>
      <span
        aria-hidden
        className="pointer-events-none absolute -top-28 -right-20 -z-10 size-72 rounded-full bg-signal/12 blur-3xl"
      />

      <h2 className="eyebrow flex items-center gap-2 text-signal">
        <Sparkles className="size-4" aria-hidden />
        Start here
      </h2>

      <p className="mt-3 text-xl leading-snug font-semibold text-balance text-fg sm:text-2xl">
        {HERO_QUESTION}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-2 text-sm text-muted">
        <span>The owner is named in</span>
        <SourceBadge source="chat" />
        <span>· the root cause is written up in</span>
        <SourceBadge source="notes" />
        <span>· no single document holds both.</span>
      </div>

      <ul className="mt-5 space-y-2 border-t border-line pt-5 text-sm text-fg-2">
        {WATCH_FOR.map((item) => (
          <li key={item} className="flex gap-2.5">
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-signal" aria-hidden />
            {item}
          </li>
        ))}
      </ul>

      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-3 pt-6">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onPick(HERO_QUESTION)}
          className="inline-flex h-11 items-center gap-2 rounded-xl bg-signal px-5 text-sm font-semibold text-on-signal shadow-sm transition-[filter,transform] duration-150 enabled:hover:brightness-110 enabled:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Play className="size-4" fill="currentColor" aria-hidden />
          Watch it answer this
        </button>

        <span className="text-xs leading-relaxed text-muted">
          {demo
            ? 'Replays a recorded run — no model calls.'
            : 'Runs live — roughly 25s, four model calls.'}
        </span>
      </div>
    </section>
  );
}

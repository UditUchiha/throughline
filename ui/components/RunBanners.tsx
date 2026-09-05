'use client';

import type { ReplayInfo } from '@/lib/run-state';
import { formatCapturedAt } from '@/lib/presentation';

/**
 * The replay banner.
 *
 * `run_replayed` always arrives first on a recording and never on a live run,
 * which is the API's honesty mechanism for PLAN.md §9's degraded demo: a
 * recording cannot present itself as live. Rendering it is the other half of
 * that contract, so this is not decoration — dropping it would break the promise.
 */
export function ReplayBanner({ replay }: { replay: ReplayInfo }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-xl border border-warn/35 bg-warn/10 px-4 py-2.5 text-sm text-warn">
      <span className="font-semibold">Recorded run.</span>
      <span className="text-ink-300">
        {replay.reason === 'quota_exhausted'
          ? 'The live provider was out of quota, so a captured run is being replayed instead.'
          : 'Replaying a captured run — no model was called.'}
      </span>
      <span className="font-mono text-[0.7rem] text-ink-500">
        {replay.slug} · captured {formatCapturedAt(replay.capturedAt)}
      </span>
    </div>
  );
}

/**
 * A mid-stream failure. `run_failed` is a real event, not a theoretical one —
 * free-tier quota is the usual cause even with a fallback chain configured — so
 * it gets a message rather than a blank screen.
 */
export function FailureBanner({ error, demo }: { error: string; demo: boolean }) {
  return (
    <div className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3">
      <p className="text-sm font-semibold text-danger">The run failed.</p>
      <p className="mt-1 font-mono text-xs leading-relaxed break-words text-ink-300">{error}</p>
      {!demo && (
        <p className="mt-2 text-xs text-ink-500">
          Free-tier quota is the usual cause. Tick{' '}
          <span className="text-ink-300">Replay a recorded run</span> above to watch a captured run
          instead — it makes no model calls.
        </p>
      )}
    </div>
  );
}

/** Distinct from a failed run: the API itself was unreachable or rejected the request. */
export function ConnectionBanner({ error, apiUrl }: { error: string; apiUrl: string }) {
  return (
    <div className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3">
      <p className="text-sm font-semibold text-danger">Could not reach the API.</p>
      <p className="mt-1 font-mono text-xs leading-relaxed break-words text-ink-300">{error}</p>
      <p className="mt-2 text-xs text-ink-500">
        Expecting it at <span className="font-mono text-ink-300">{apiUrl}</span>. Start it with{' '}
        <span className="font-mono text-ink-300">pnpm start:dev</span>, or point{' '}
        <span className="font-mono text-ink-300">NEXT_PUBLIC_API_URL</span> somewhere else.
      </p>
    </div>
  );
}

'use client';

import { RUN_STAGES, runStages, type RunView } from '@/lib/run-state';
import { formatMs } from '@/lib/presentation';
import { STAGE_DOING } from './stages';

/**
 * One sentence on where the run is. A 25-second run with no indicator reads as a
 * hung one; the five-step strip this replaces answered a question a first-time
 * visitor had not asked.
 */
export function RunProgress({ view, elapsedMs }: { view: RunView; elapsedMs: number }) {
  const stages = runStages(view);
  const current = RUN_STAGES.find((id) => stages[id] === 'active' || stages[id] === 'failed');
  const stopped = view.error === 'Stopped.';

  let headline: string;
  let dot: string;
  if (view.status === 'streaming') {
    headline = current ? `${STAGE_DOING[current]}…` : 'Starting…';
    dot = 'running-bar bg-signal';
  } else if (view.status === 'finished') {
    headline = view.answer?.abstained ? 'Declined to answer' : 'Answered';
    dot = 'bg-signal';
  } else {
    headline = stopped ? 'Stopped' : 'Failed';
    dot = 'bg-danger';
  }

  return (
    <p role="status" className="animate-enter flex items-center gap-2 text-sm text-fg-2">
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${dot}`} />
      {headline}
      <span className="ml-auto font-mono text-xs text-muted tabular-nums">
        {formatMs(view.status === 'streaming' ? elapsedMs : view.latencyMs)}
      </span>
    </p>
  );
}

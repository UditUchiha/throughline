'use client';

import { Check, X } from 'lucide-react';
import {
  RUN_STAGES,
  hopCount,
  runStages,
  type RunStageId,
  type RunStageStatus,
  type RunView,
} from '@/lib/run-state';
import { formatMs } from '@/lib/presentation';
import { STAGE_META } from './stages';

/**
 * Where the run is, at a glance.
 *
 * The panels below say *what* each stage produced; this says which stage is
 * happening now, which is otherwise a matter of scanning five panels for the one
 * still changing. A 25-second run with no progress indicator reads as a hung one.
 */
export function RunProgress({ view, elapsedMs }: { view: RunView; elapsedMs: number }) {
  const stages = runStages(view);
  const current = RUN_STAGES.find((id) => stages[id] === 'active' || stages[id] === 'failed');
  const stopped = view.error === 'Stopped.';

  let headline: string;
  let dot: string;
  if (view.status === 'streaming') {
    headline = current ? `${STAGE_META[current].doing}…` : 'Starting…';
    dot = 'running-bar bg-signal';
  } else if (view.status === 'finished') {
    headline = view.answer?.abstained ? 'Finished — abstained' : 'Finished';
    dot = 'bg-signal';
  } else {
    headline = stopped ? 'Stopped' : 'Failed';
    dot = 'bg-danger';
  }

  return (
    <section aria-label="Run progress" className="panel animate-enter px-3 py-4 sm:px-5">
      <div className="mb-4 flex items-center justify-between gap-3 px-1">
        {/* A status region, so a screen reader hears each stage change without
            having to find it — the visual equivalent is the lit step below. */}
        <p role="status" className="eyebrow flex items-center gap-2 text-fg-2">
          <span aria-hidden className={`size-2 rounded-full ${dot}`} />
          {headline}
        </p>
        <span className="font-mono text-sm text-muted tabular-nums">
          {formatMs(view.status === 'streaming' ? elapsedMs : view.latencyMs)}
        </span>
      </div>

      <ol className="grid grid-cols-5">
        {RUN_STAGES.map((id, index) => (
          <Step
            key={id}
            id={id}
            status={stages[id]}
            first={index === 0}
            detail={detailFor(id, view, stages[id], stopped)}
          />
        ))}
      </ol>
    </section>
  );
}

const CIRCLE: Record<RunStageStatus, string> = {
  pending: 'border-line bg-surface-2 text-faint',
  active:
    'border-signal bg-[color-mix(in_oklab,var(--signal)_16%,var(--surface))] text-signal',
  done: 'border-signal bg-signal text-on-signal',
  skipped: 'border-dashed border-line-strong bg-surface text-faint',
  failed: 'border-danger bg-[color-mix(in_oklab,var(--danger)_16%,var(--surface))] text-danger',
};

const LABEL: Record<RunStageStatus, string> = {
  pending: 'text-faint',
  active: 'text-fg',
  done: 'text-fg-2',
  skipped: 'text-muted',
  failed: 'text-danger',
};

function Step({
  id,
  status,
  first,
  detail,
}: {
  id: RunStageId;
  status: RunStageStatus;
  first: boolean;
  detail: { short: string; long: string } | null;
}) {
  const meta = STAGE_META[id];
  const Icon = status === 'done' ? Check : status === 'failed' ? X : meta.icon;
  const reached = status !== 'pending';

  return (
    <li className="relative flex min-w-0 flex-col items-center text-center">
      {/* The connector runs from the previous step's centre to this one's, and
          lights once this step has been reached. */}
      {!first && (
        <span
          aria-hidden
          className={`absolute top-4 right-1/2 h-0.5 w-full -translate-y-1/2 transition-colors duration-300 ${
            reached ? 'bg-signal/60' : 'bg-line'
          }`}
        />
      )}

      <span
        className={`relative z-10 flex size-8 items-center justify-center rounded-full border transition-colors duration-300 ${CIRCLE[status]}`}
      >
        <Icon className="size-4" aria-hidden />
        {status === 'active' && (
          <span
            aria-hidden
            className="running-bar absolute -inset-1.5 rounded-full border-2 border-signal/35"
          />
        )}
      </span>

      <span className={`mt-2 text-xs font-medium ${LABEL[status]}`}>{meta.label}</span>
      <span className="sr-only">: {status}</span>
      <span
        className="mt-0.5 h-4 max-w-full truncate px-0.5 font-mono text-xs text-faint"
        title={detail?.long}
      >
        {detail && (
          <>
            <span className="sm:hidden">{detail.short}</span>
            <span className="hidden sm:inline">{detail.long}</span>
          </>
        )}
      </span>
    </li>
  );
}

/** What each stage produced, short enough for a 64px column on a phone. */
function detailFor(
  id: RunStageId,
  view: RunView,
  status: RunStageStatus,
  stopped: boolean,
): { short: string; long: string } | null {
  const same = (text: string) => ({ short: text, long: text });

  if (status === 'pending') return null;
  if (status === 'skipped') return same('skipped');
  if (status === 'failed') return same(stopped ? 'stopped' : 'failed');

  switch (id) {
    case 'triage':
      return view.triage ? same(view.triage.complexity) : null;
    case 'plan': {
      if (!view.planned) return null;
      const count = view.subQuestions.filter((sq) => sq.hop === 0).length;
      return { short: `${count} parts`, long: `${count} sub-questions` };
    }
    case 'retrieve': {
      const calls = view.toolCalls.length;
      if (calls === 0) return null;
      const rounds = hopCount(view) + 1;
      return {
        short: `${calls} call${calls === 1 ? '' : 's'}`,
        long: `${calls} call${calls === 1 ? '' : 's'}${rounds > 1 ? ` · ${rounds} rounds` : ''}`,
      };
    }
    case 'reflect': {
      if (view.reflections.length === 0) return null;
      const gaps = view.reflections.filter((reflection) => reflection.gapFound).length;
      return same(gaps === 0 ? 'no gaps' : `${gaps} gap${gaps === 1 ? '' : 's'}`);
    }
    case 'answer':
      if (view.status !== 'finished') return null;
      return view.answer?.abstained
        ? same('abstained')
        : { short: `${view.citations.length} cited`, long: `${view.citations.length} citations` };
  }
}

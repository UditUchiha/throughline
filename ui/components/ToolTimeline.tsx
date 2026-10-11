'use client';

import { CircleAlert, ScanSearch } from 'lucide-react';
import { retrievalWindow, type RunView, type ToolCall } from '@/lib/run-state';
import { formatMs, sourceForTool, sourceStyle } from '@/lib/presentation';
import { Panel, Waiting } from './Panel';
import { SourceIcon } from './SourceBadge';

/**
 * Horizontal bars for every tool call, on a shared time axis.
 *
 * PLAN.md §5/M2 calls this "the single most compelling visual", and the reason is
 * that parallelism is otherwise invisible: two sub-questions that ran together and
 * two that ran back to back produce the same list, and only the same axis
 * separates them.
 *
 * The axis spans the *retrieval* window — first tool start to last tool finish —
 * not the whole run. Model calls dominate wall-clock (a 26s run can finish all its
 * retrieval inside 4s), so scaling to the run would squeeze every bar into a
 * sliver and destroy the one thing the chart exists to show. Total run time is in
 * the stats panel, where it is not competing with anything.
 */
export function ToolTimeline({ view }: { view: RunView }) {
  const window = retrievalWindow(view);
  const span = window ? window.endMs - window.startMs : 0;

  return (
    <Panel
      title="Retrieval"
      icon={ScanSearch}
      meta={
        window && (
          <>
            {view.toolCalls.length} call{view.toolCalls.length === 1 ? '' : 's'} over{' '}
            {formatMs(span)}
          </>
        )
      }
    >
      {!window ? (
        <Waiting live={view.status === 'streaming'}>No tool calls yet…</Waiting>
      ) : (
        <>
          <ol className="space-y-3.5">
            {view.toolCalls.map((call) => (
              <TimelineRow
                key={call.key}
                call={call}
                windowStartMs={window.startMs}
                spanMs={span}
              />
            ))}
          </ol>

          <div className="mt-4 flex justify-between border-t border-line pt-2 font-mono text-xs text-faint tabular-nums">
            <span>0ms</span>
            <span>{formatMs(span / 2)}</span>
            <span>{formatMs(span)}</span>
          </div>
        </>
      )}
    </Panel>
  );
}

function TimelineRow({
  call,
  windowStartMs,
  spanMs,
}: {
  call: ToolCall;
  windowStartMs: number;
  spanMs: number;
}) {
  const source = sourceForTool(call.tool);
  const style = sourceStyle(source);
  const running = call.finishedAtMs === null;
  const failed = call.error !== null;

  const offsetPercent = ((call.startedAtMs - windowStartMs) / spanMs) * 100;
  const endMs = call.finishedAtMs ?? call.startedAtMs;
  // A 500ms call inside a 30s window is 1.7% wide; without a floor the bar would
  // be a hairline and the latency it represents unreadable.
  const widthPercent = Math.max(((endMs - call.startedAtMs) / spanMs) * 100, 3);

  return (
    <li className={`${style.className} animate-enter`}>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span
          className={`flex min-w-0 items-center gap-1.5 font-mono font-medium ${
            failed ? 'text-danger' : 'text-accent'
          }`}
        >
          {failed ? (
            <CircleAlert className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <SourceIcon source={source} className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{call.tool}</span>
        </span>
        <span className="shrink-0 font-mono text-muted tabular-nums">
          {call.subQuestionId} ·{' '}
          {running ? 'running…' : failed ? 'failed' : formatMs(call.latencyMs)}
        </span>
      </div>

      <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-surface-3/70">
        <div
          className={`h-full rounded-full ${failed ? 'bg-danger' : 'bg-accent'} ${
            running ? 'running-bar' : ''
          }`}
          style={{
            marginInlineStart: `${Math.min(Math.max(offsetPercent, 0), 97)}%`,
            width: `${Math.min(widthPercent, 100)}%`,
          }}
          role="img"
          aria-label={`${call.tool} for ${call.subQuestionId}: started ${formatMs(
            call.startedAtMs - windowStartMs,
          )} into retrieval, ${
            running
              ? 'still running'
              : failed
                ? `failed after ${formatMs(call.latencyMs)} — ${call.error}`
                : `took ${formatMs(call.latencyMs)}`
          }`}
        />
      </div>

      {/* The error replaces the query rather than joining it: a call that threw
          retrieved nothing, so what it searched for is no longer the useful fact. */}
      <p
        className={`mt-1.5 truncate text-xs ${failed ? 'text-danger' : 'text-muted'}`}
        title={failed ? call.error! : call.input}
      >
        {failed ? call.error : call.input}
      </p>
    </li>
  );
}

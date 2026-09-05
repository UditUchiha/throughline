'use client';

import { retrievalWindow, type RunView, type ToolCall } from '@/lib/run-state';
import { formatMs, sourceForTool, sourceStyle } from '@/lib/presentation';

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
    <section className="panel">
      <div className="panel-heading">
        <span>Retrieval</span>
        {window && (
          <span className="font-normal normal-case text-ink-500">
            {view.toolCalls.length} call{view.toolCalls.length === 1 ? '' : 's'} over{' '}
            {formatMs(span)}
          </span>
        )}
      </div>

      <div className="p-3 sm:p-4">
        {!window ? (
          <p className="font-mono text-xs text-ink-700">no tool calls yet…</p>
        ) : (
          <>
            <ol className="space-y-2.5">
              {view.toolCalls.map((call) => (
                <TimelineRow
                  key={call.key}
                  call={call}
                  windowStartMs={window.startMs}
                  spanMs={span}
                />
              ))}
            </ol>

            <div className="mt-3 flex justify-between border-t border-white/8 pt-1.5 font-mono text-[0.6rem] text-ink-700">
              <span>0ms</span>
              <span>{formatMs(span)}</span>
            </div>
          </>
        )}
      </div>
    </section>
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
  const style = sourceStyle(sourceForTool(call.tool));
  const running = call.finishedAtMs === null;
  const failed = call.error !== null;

  const offsetPercent = ((call.startedAtMs - windowStartMs) / spanMs) * 100;
  const endMs = call.finishedAtMs ?? call.startedAtMs;
  // A 500ms call inside a 30s window is 1.7% wide; without a floor the bar would
  // be a hairline and the latency it represents unreadable.
  const widthPercent = Math.max(((endMs - call.startedAtMs) / spanMs) * 100, 3);

  return (
    <li className={style.className}>
      <div className="flex items-baseline justify-between gap-2 text-[0.7rem]">
        <span
          className={`truncate font-mono ${failed ? 'text-danger' : 'text-[var(--accent)]'}`}
        >
          {call.tool}
        </span>
        <span className="shrink-0 font-mono text-ink-700">
          {call.subQuestionId} ·{' '}
          {running ? 'running…' : failed ? 'failed' : formatMs(call.latencyMs)}
        </span>
      </div>

      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-ink-950/70">
        <div
          className={`h-full rounded-full ${failed ? 'bg-danger' : 'bg-[var(--accent)]'} ${
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
        className={`mt-1 truncate text-[0.7rem] ${failed ? 'text-danger' : 'text-ink-700'}`}
        title={failed ? call.error! : call.input}
      >
        {failed ? call.error : call.input}
      </p>
    </li>
  );
}

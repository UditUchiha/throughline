'use client';

import { hopCount, type RunView } from '@/lib/run-state';
import { formatCost, formatMs, formatTokens } from '@/lib/presentation';

export function RunStats({ view, elapsedMs }: { view: RunView; elapsedMs: number }) {
  const running = view.status === 'streaming';
  const tokens = view.usage;

  return (
    <section className="panel">
      <div className="panel-heading">
        <span>Run</span>
        {view.runId && (
          <span
            className="truncate font-normal normal-case text-ink-700"
            title={`runId ${view.runId}`}
          >
            {view.runId.slice(0, 8)}
          </span>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-b-xl bg-white/6 sm:grid-cols-3">
        <Stat
          label="latency"
          value={running ? formatMs(elapsedMs) : formatMs(view.latencyMs)}
          hint={running ? 'still running' : undefined}
        />
        <Stat label="complexity" value={view.triage?.complexity ?? '—'} />
        <Stat
          label="hops"
          value={view.toolCalls.length === 0 ? '—' : String(hopCount(view))}
          hint="extra rounds"
        />
        <Stat label="tool calls" value={String(view.toolCalls.length)} />
        <Stat label="evidence" value={String(view.evidence.length)} />
        <Stat label="citations" value={String(view.citations.length)} />
        <Stat
          label="tokens in"
          value={tokens ? formatTokens(tokens.inputTokens) : '—'}
          className="sm:col-span-1"
        />
        <Stat label="tokens out" value={tokens ? formatTokens(tokens.outputTokens) : '—'} />
        <Stat label="cost" value={view.status === 'finished' ? formatCost(view.costUsd) : '—'} />

        <div className="col-span-2 bg-ink-900/70 px-3 py-2.5 sm:col-span-3">
          <dt className="font-mono text-[0.6rem] tracking-widest text-ink-700 uppercase">
            served by
          </dt>
          <dd className="mt-0.5 font-mono text-xs break-all text-ink-300">
            {view.models.length > 0 ? (
              view.models.join(' → ')
            ) : (
              <span className="text-ink-700">
                {view.replay
                  ? 'not recorded — this run was captured before the field existed'
                  : '—'}
              </span>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
  className = '',
}: {
  label: string;
  value: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={`bg-ink-900/70 px-3 py-2.5 ${className}`}>
      <dt className="font-mono text-[0.6rem] tracking-widest text-ink-700 uppercase">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm text-ink-100">
        {value}
        {hint && <span className="ml-1.5 text-[0.6rem] text-ink-700">{hint}</span>}
      </dd>
    </div>
  );
}

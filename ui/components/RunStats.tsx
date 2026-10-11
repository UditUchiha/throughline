'use client';

import { Activity } from 'lucide-react';
import { hopCount, type RunView } from '@/lib/run-state';
import { formatCost, formatMs, formatTokens } from '@/lib/presentation';
import { Panel } from './Panel';

export function RunStats({ view, elapsedMs }: { view: RunView; elapsedMs: number }) {
  const running = view.status === 'streaming';
  const tokens = view.usage;

  return (
    <Panel
      title="Run"
      icon={Activity}
      className="overflow-hidden"
      bodyClassName=""
      meta={
        view.runId && (
          <span className="truncate text-faint" title={`runId ${view.runId}`}>
            {view.runId.slice(0, 8)}
          </span>
        )
      }
    >
      <dl className="grid grid-cols-2 gap-px bg-line sm:grid-cols-3">
        <Stat
          label="latency"
          value={running ? formatMs(elapsedMs) : formatMs(view.latencyMs)}
          hint={running ? 'running' : undefined}
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
        <Stat label="tokens in" value={tokens ? formatTokens(tokens.inputTokens) : '—'} />
        <Stat label="tokens out" value={tokens ? formatTokens(tokens.outputTokens) : '—'} />
        {/* Nine stats leave an orphan cell in two columns; the last one closes the row. */}
        <Stat
          label="cost"
          value={view.status === 'finished' ? formatCost(view.costUsd) : '—'}
          className="col-span-2 sm:col-span-1"
        />

        <div className="col-span-2 bg-surface px-4 py-3 sm:col-span-3">
          <dt className="font-mono text-xs tracking-wider text-faint uppercase">served by</dt>
          <dd className="mt-1 font-mono text-sm break-all text-fg-2">
            {view.models.length > 0 ? (
              view.models.join(' → ')
            ) : (
              <span className="text-muted">
                {view.replay
                  ? 'not recorded — this run was captured before the field existed'
                  : '—'}
              </span>
            )}
          </dd>
        </div>
      </dl>
    </Panel>
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
    <div className={`bg-surface px-4 py-3 ${className}`}>
      <dt className="font-mono text-xs tracking-wider text-faint uppercase">{label}</dt>
      <dd className="mt-1 flex flex-wrap items-baseline gap-x-1.5 font-mono text-base text-fg tabular-nums">
        {value}
        {hint && <span className="text-xs text-faint">{hint}</span>}
      </dd>
    </div>
  );
}

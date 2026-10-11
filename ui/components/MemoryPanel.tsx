'use client';

import { ArrowDownLeft, ArrowUpRight, History } from 'lucide-react';
import type { RunView } from '@/lib/run-state';
import { Code, Panel } from './Panel';

/**
 * What memory gave this run and what it took away.
 *
 * Short-term (within-session) memory: the refs here are the conversation turns
 * `recall` read before triage, plus the turn `synthesize` committed at the end.
 * Long-term facts (M4.2) arrive through the same two events when that store is
 * enabled — it is off on the public instance.
 *
 * A replayed run shows nothing, and correctly so — a recording has no session.
 */
export function MemoryPanel({ view }: { view: RunView }) {
  return (
    <Panel
      title="Memory"
      icon={History}
      meta={<span className="text-faint">{view.memory.length === 0 ? 'session' : summarise(view.memory)}</span>}
    >
      {view.memory.length === 0 ? (
        <p className="text-sm leading-relaxed text-muted">
          Nothing yet. The first question of a session has no conversation behind it, so{' '}
          <Code>memory_read</Code> carries nothing — ask a follow-up and the turns it resolved
          against appear here. A replayed run has no session at all.
        </p>
      ) : (
        <ul className="space-y-2">
          {view.memory.map((ref) => {
            const read = ref.direction === 'read';
            const Icon = read ? ArrowDownLeft : ArrowUpRight;
            return (
              <li
                key={ref.id}
                className="animate-enter rounded-xl border border-line bg-surface-2/60 p-3"
              >
                <span className="flex items-center gap-1.5 font-mono text-xs">
                  <Icon
                    className={`size-3.5 ${read ? 'text-signal' : 'text-muted'}`}
                    aria-hidden
                  />
                  <span className={read ? 'text-signal' : 'text-muted'}>
                    {read ? 'read' : 'written'}
                  </span>
                  <span className="text-faint">· {ref.kind}</span>
                </span>
                <p className="mt-1.5 text-sm leading-relaxed text-fg-2">{ref.text}</p>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/** e.g. "1 read · 1 written" — the panel's heading has room for the shape, not the detail. */
function summarise(memory: RunView['memory']): string {
  const read = memory.filter((ref) => ref.direction === 'read').length;
  const written = memory.length - read;
  return [read > 0 && `${read} read`, written > 0 && `${written} written`]
    .filter(Boolean)
    .join(' · ');
}

'use client';

import type { RunView } from '@/lib/run-state';

/**
 * What memory gave this run and what it took away.
 *
 * Short-term (within-session) memory is live as of M4.1: the refs here are the
 * conversation turns `recall` read before triage, plus the turn `synthesize`
 * committed at the end. M4.2 puts long-term facts through the same two events.
 *
 * A replayed run shows nothing, and correctly so — a recording has no session.
 */
export function MemoryPanel({ view }: { view: RunView }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <span>Memory</span>
        <span className="font-normal normal-case text-ink-700">
          {view.memory.length === 0 ? 'session' : summarise(view.memory)}
        </span>
      </div>

      <div className="p-3 sm:p-4">
        {view.memory.length === 0 ? (
          <p className="text-xs leading-relaxed text-ink-700">
            Nothing yet. The first question of a session has no conversation behind it, so{' '}
            <Code>memory_read</Code> carries nothing — ask a follow-up and the turns it resolved
            against appear here. A replayed run has no session at all. Long-term memory across
            sessions lands in M4.2.
          </p>
        ) : (
          <ul className="space-y-2">
            {view.memory.map((ref) => (
              <li key={ref.id} className="rounded-lg border border-white/8 bg-ink-900/50 p-2.5">
                <span className="flex items-center gap-1.5 font-mono text-[0.6rem] tracking-wide">
                  <span className={ref.direction === 'read' ? 'text-signal' : 'text-ink-500'}>
                    {ref.direction === 'read' ? '← read' : '→ written'}
                  </span>
                  <span className="text-ink-700">{ref.kind}</span>
                </span>
                <p className="mt-1 text-xs text-ink-300">{ref.text}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
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

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-ink-950/80 px-1 py-0.5 font-mono text-[0.7rem] text-ink-500">
      {children}
    </code>
  );
}

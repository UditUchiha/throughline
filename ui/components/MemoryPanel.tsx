'use client';

import type { RunView } from '@/lib/run-state';

/**
 * Memory is M4. The panel ships now because the events (`memory_read` /
 * `memory_written`) are already in the frozen contract and emit empty — so this is
 * wiring that is finished, waiting on a producer, rather than a stub to revisit.
 */
export function MemoryPanel({ view }: { view: RunView }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <span>Memory</span>
        <span className="font-normal normal-case text-ink-700">M4</span>
      </div>

      <div className="p-3 sm:p-4">
        {view.memory.length === 0 ? (
          <p className="text-xs leading-relaxed text-ink-700">
            Nothing remembered yet. The agent emits <Code>memory_read</Code> and{' '}
            <Code>memory_written</Code> already; both are empty until long-term memory lands in M4,
            and this panel renders whatever they carry.
          </p>
        ) : (
          <ul className="space-y-2">
            {view.memory.map((ref) => (
              <li key={ref.id} className="rounded-lg border border-white/8 bg-ink-900/50 p-2.5">
                <span className="font-mono text-[0.6rem] tracking-wide text-ink-700">
                  {ref.kind}
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

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-ink-950/80 px-1 py-0.5 font-mono text-[0.7rem] text-ink-500">
      {children}
    </code>
  );
}

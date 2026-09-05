'use client';

import type { RunView } from '@/lib/run-state';

/**
 * Triage's verdict, first in the trace because it is first in the graph — and
 * because knowing when *not* to decompose is a measured latency and cost win, not
 * a shortcut. A simple question skips the planning model call entirely.
 */
export function TriageCard({ view }: { view: RunView }) {
  const complex = view.triage?.complexity === 'complex';

  return (
    <section className="panel">
      <div className="panel-heading">
        <span>Triage</span>
        {view.triage && (
          <span
            className={`font-mono text-[0.7rem] normal-case ${complex ? 'text-notes' : 'text-signal'}`}
          >
            {view.triage.complexity}
          </span>
        )}
      </div>

      <div className="p-3 sm:p-4">
        {view.triage ? (
          <p className="text-sm leading-relaxed text-ink-300">{view.triage.reasoning}</p>
        ) : (
          <p className="font-mono text-xs text-ink-700">
            {view.status === 'streaming' ? 'classifying…' : 'not started'}
          </p>
        )}
      </div>
    </section>
  );
}

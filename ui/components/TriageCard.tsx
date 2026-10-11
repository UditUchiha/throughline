'use client';

import { Gauge } from 'lucide-react';
import type { RunView } from '@/lib/run-state';
import { Panel, Waiting } from './Panel';

/**
 * Triage's verdict, first in the trace because it is first in the graph — and
 * because knowing when *not* to decompose is a measured latency and cost win, not
 * a shortcut. A simple question skips the planning model call entirely.
 */
export function TriageCard({ view }: { view: RunView }) {
  const complex = view.triage?.complexity === 'complex';

  return (
    <Panel
      title="Triage"
      icon={Gauge}
      meta={
        view.triage && (
          <span
            className={`${complex ? 'source-notes' : ''} rounded-full border px-2 py-0.5 ${
              complex
                ? 'border-accent/40 bg-accent/14 text-accent'
                : 'border-signal/40 bg-signal/14 text-signal'
            }`}
          >
            {view.triage.complexity}
          </span>
        )
      }
    >
      {view.triage ? (
        <p className="text-sm leading-relaxed text-fg-2">{view.triage.reasoning}</p>
      ) : (
        <Waiting live={view.status === 'streaming'}>
          {view.status === 'streaming' ? 'Classifying the question…' : 'Not started.'}
        </Waiting>
      )}
    </Panel>
  );
}

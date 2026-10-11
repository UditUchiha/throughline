import { Workflow } from 'lucide-react';
import { RUN_STAGES } from '@/lib/run-state';
import { Panel } from './Panel';
import { SourceBadge } from './SourceBadge';
import { STAGE_META } from './stages';

/** The argument, before the visitor has asked anything. Shown only while idle. */
export function Intro() {
  return (
    <section className="animate-enter pt-10 sm:pt-16">
      <p className="eyebrow inline-flex items-center gap-2 rounded-full border border-line bg-surface/70 px-3 py-1.5 text-muted">
        <span aria-hidden className="size-1.5 rounded-full bg-signal" />
        Agentic RAG over mail, chat and notes
      </p>

      <h1 className="mt-5 max-w-3xl text-4xl leading-[1.08] font-semibold tracking-tight text-balance text-fg sm:text-5xl lg:text-6xl">
        Some answers are not in{' '}
        <span className="bg-linear-to-r from-signal to-chat bg-clip-text text-transparent">
          any one document.
        </span>
      </h1>

      <p className="mt-5 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
        The cause is in a chat thread, the sign-off is in an email. Ordinary RAG retrieves the
        nearest passage and stops. This agent plans the decomposition, searches mail, chat and
        notes in parallel, notices what it is still missing, and cites the passage behind every
        claim.
      </p>
    </section>
  );
}

/**
 * The five stages, in the same icons the progress strip lights up during a run —
 * so the vocabulary is learned here, before it is needed.
 *
 * `wide` lays the stages out in a row when there is no hero card beside them.
 */
export function HowItWorks({ wide, className = '' }: { wide: boolean; className?: string }) {
  return (
    <Panel title="How a run works" icon={Workflow} className={className}>
      <ol className={`grid gap-4 ${wide ? 'sm:grid-cols-2 lg:grid-cols-5' : ''}`}>
        {RUN_STAGES.map((id, index) => {
          const meta = STAGE_META[id];
          const Icon = meta.icon;
          return (
            <li key={id} className="flex gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-signal">
                <Icon className="size-4" aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg">
                  <span className="mr-1.5 font-mono text-xs text-faint">{index + 1}</span>
                  {meta.label}
                </p>
                <p className="mt-0.5 text-sm leading-snug text-muted">{meta.blurb}</p>
                {id === 'retrieve' && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <SourceBadge source="mail" />
                    <SourceBadge source="chat" />
                    <SourceBadge source="notes" />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

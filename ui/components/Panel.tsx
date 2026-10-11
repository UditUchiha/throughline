import type { LucideIcon } from 'lucide-react';

/**
 * The frame every trace panel shares: an icon, a title, and a short readout on
 * the right that summarises the panel's state without opening it.
 *
 * `highlight` draws the one accent line on the page that is not a source colour,
 * and is meant for the answer alone — it is the payoff the trace builds toward.
 */
export function Panel({
  title,
  icon: Icon,
  meta,
  highlight = false,
  className = '',
  bodyClassName = 'p-4',
  children,
}: {
  title: string;
  icon: LucideIcon;
  meta?: React.ReactNode;
  highlight?: boolean;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`panel animate-enter relative ${className}`}>
      {highlight && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-6 top-0 h-px bg-linear-to-r from-transparent via-signal/80 to-transparent"
        />
      )}
      <header className="flex min-h-12 items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <h2 className="eyebrow flex items-center gap-2 text-muted">
          <Icon className="size-4 text-faint" aria-hidden />
          {title}
        </h2>
        {meta !== undefined && (
          <div className="flex min-w-0 items-center gap-2 font-mono text-xs text-muted">{meta}</div>
        )}
      </header>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/** A placeholder line for a panel whose data has not arrived. */
export function Waiting({ live, children }: { live: boolean; children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted">
      <span
        aria-hidden
        className={`size-1.5 shrink-0 rounded-full ${live ? 'running-bar bg-signal' : 'bg-faint'}`}
      />
      {children}
    </p>
  );
}

export function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[0.8125rem] text-fg-2">
      {children}
    </code>
  );
}

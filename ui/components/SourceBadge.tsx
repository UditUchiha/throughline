import type { CorpusSource } from '@/lib/agent-events';
import { sourceStyle } from '@/lib/presentation';

/**
 * The one place a source is turned into a visible thing. Everything that shows a
 * source goes through it, so mail is the same amber in the timeline, the evidence
 * list and the plan.
 */
export function SourceBadge({
  source,
  children,
  title,
}: {
  source: CorpusSource | null;
  children?: React.ReactNode;
  title?: string;
}) {
  const style = sourceStyle(source);

  return (
    <span
      title={title}
      className={`${style.className} inline-flex items-center gap-1.5 rounded-full border border-[color-mix(in_oklch,var(--accent)_45%,transparent)] bg-[color-mix(in_oklch,var(--accent)_14%,transparent)] px-2 py-0.5 font-mono text-[0.65rem] tracking-wide text-[var(--accent)]`}
    >
      <span className="size-1.5 rounded-full bg-[var(--accent)]" aria-hidden />
      {children ?? style.label}
    </span>
  );
}

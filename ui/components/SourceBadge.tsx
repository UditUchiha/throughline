import { Layers, Mail, MessagesSquare, NotebookPen, type LucideIcon } from 'lucide-react';
import { KNOWN_SOURCES, type CorpusSource, type KnownSource } from '@/lib/agent-events';
import { sourceStyle } from '@/lib/presentation';

/**
 * A shape per source as well as a colour, so the three are distinguishable by
 * someone who cannot tell amber from violet. Unknown sources get the neutral
 * stack — the same fallback `sourceStyle` applies to the colour.
 */
const SOURCE_ICONS: Record<KnownSource, LucideIcon> = {
  mail: Mail,
  chat: MessagesSquare,
  notes: NotebookPen,
};

export function SourceIcon({
  source,
  className = 'size-3.5',
}: {
  source: CorpusSource | null;
  className?: string;
}) {
  const known = KNOWN_SOURCES.find((candidate) => candidate === source);
  const Icon = known ? SOURCE_ICONS[known] : Layers;
  return <Icon className={className} aria-hidden />;
}

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
      className={`${style.className} inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full border border-accent/40 bg-accent/14 px-2 py-0.5 font-mono text-xs text-accent`}
    >
      <SourceIcon source={source} className="size-3.5 shrink-0" />
      <span className="truncate">{children ?? style.label}</span>
    </span>
  );
}

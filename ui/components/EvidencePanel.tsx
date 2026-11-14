'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, FileStack } from 'lucide-react';
import type { CorpusSource, Evidence } from '@/lib/agent-events';
import { markersByEvidenceId, type RunView } from '@/lib/run-state';
import { sourceStyle } from '@/lib/presentation';
import { Panel, Waiting } from './Panel';
import { SourceBadge } from './SourceBadge';

export function evidenceDomId(evidenceId: string): string {
  return `evidence-${evidenceId}`;
}

/**
 * The order the known sources are shown in. Not an allowlist — see
 * {@link groupBySource}, which appends anything else rather than filtering it
 * out.
 */
const SOURCE_ORDER: (CorpusSource | 'unknown')[] = ['mail', 'chat', 'notes', 'unknown'];

/**
 * Retrieved chunks, grouped by source.
 *
 * Grouping is the point rather than a tidy-up: the claim the project makes is
 * that an answer was assembled from separate places, and a single ranked list
 * makes that claim invisible.
 */
export function EvidencePanel({
  view,
  focus,
}: {
  view: RunView;
  /** Set by a citation chip. `nonce` re-fires the scroll when the same chip is clicked twice. */
  focus: { evidenceId: string; nonce: number } | null;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** The `focus.nonce` whose flash has already elapsed, and whose card was collapsed. */
  const [flashedNonce, setFlashedNonce] = useState<number | null>(null);
  const [collapsedNonce, setCollapsedNonce] = useState<number | null>(null);

  const markers = useMemo(() => markersByEvidenceId(view.citations), [view.citations]);
  // Cited passages are the proof; the rest is what it read on the way. Until the
  // answer names its citations (or when it abstains and names none) there is no
  // split to make, and everything retrieved is the story.
  const { cited, rest } = useMemo(() => {
    if (markers.size === 0) return { cited: view.evidence, rest: [] };
    return {
      cited: view.evidence.filter((item) => markers.has(item.evidenceId)),
      rest: view.evidence.filter((item) => !markers.has(item.evidenceId)),
    };
  }, [view.evidence, markers]);
  const citedGroups = useMemo(() => groupBySource(cited), [cited]);
  const restGroups = useMemo(() => groupBySource(rest), [rest]);

  // Expansion is *derived* from focus rather than pushed into state by the effect
  // below. That is not only tidier: setting it in the effect meant the scroll ran
  // against the still-collapsed card and landed on a two-line summary, with the
  // passage the citation points at appearing underneath it a frame later.
  const focusOpen = focus !== null && collapsedNonce !== focus.nonce;
  const isExpanded = (evidenceId: string): boolean =>
    expanded.has(evidenceId) || (focusOpen && focus.evidenceId === evidenceId);

  const flashingId = focus && flashedNonce !== focus.nonce ? focus.evidenceId : null;

  useEffect(() => {
    if (!focus) return;

    const element = document.getElementById(evidenceDomId(focus.evidenceId));
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Two seconds of accent, then it stops — long enough to find the card, short
    // enough not to become permanent noise.
    const timer = setTimeout(() => setFlashedNonce(focus.nonce), 2000);
    return () => clearTimeout(timer);
  }, [focus]);

  const toggle = (evidenceId: string): void => {
    if (isExpanded(evidenceId)) {
      // A card opened by a citation is not in `expanded`, so collapsing it has to
      // record that this jump was dismissed — otherwise the chevron would do nothing.
      if (focusOpen && focus.evidenceId === evidenceId) setCollapsedNonce(focus.nonce);
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(evidenceId);
        return next;
      });
      return;
    }
    setExpanded((current) => new Set(current).add(evidenceId));
  };

  const renderGroups = (groups: ReturnType<typeof groupBySource>) =>
    groups.map((group) => (
      <div key={group.source}>
        <div className="mb-2.5 flex items-center gap-2">
          <SourceBadge source={group.source === 'unknown' ? null : group.source} />
          <span className="font-mono text-xs text-faint">
            {group.evidence.length} passage{group.evidence.length === 1 ? '' : 's'}
          </span>
          <span aria-hidden className="h-px flex-1 bg-line" />
        </div>

        <ul className="space-y-2">
          {group.evidence.map((evidence) => (
            <EvidenceCard
              key={evidence.evidenceId}
              evidence={evidence}
              marker={markers.get(evidence.evidenceId)}
              expanded={isExpanded(evidence.evidenceId)}
              flashing={flashingId === evidence.evidenceId}
              onToggle={() => toggle(evidence.evidenceId)}
            />
          ))}
        </ul>
      </div>
    ));

  return (
    <Panel
      title="Where this came from"
      icon={FileStack}
      meta={
        view.evidence.length === 0
          ? 'none yet'
          : markers.size === 0
            ? `${view.evidence.length} passage${view.evidence.length === 1 ? '' : 's'} read`
            : `${cited.length} cited · ${view.evidence.length} read`
      }
    >
      <div className="space-y-6">
        {view.evidence.length === 0 && (
          <Waiting live={view.status === 'streaming'}>Nothing retrieved yet…</Waiting>
        )}

        {renderGroups(citedGroups)}

        {rest.length > 0 && (
          <details className="group">
            <summary className="inline-flex h-9 cursor-pointer list-none items-center gap-2 rounded-lg border border-line bg-surface-2/60 px-3 text-sm text-fg-2 transition-colors duration-150 select-none hover:border-line-strong hover:text-fg [&::-webkit-details-marker]:hidden">
              <ChevronDown
                className="size-4 transition-transform duration-200 group-open:rotate-180"
                aria-hidden
              />
              {rest.length} more passage{rest.length === 1 ? '' : 's'} it read but did not cite
            </summary>
            <div className="mt-4 space-y-6">{renderGroups(restGroups)}</div>
          </details>
        )}
      </div>
    </Panel>
  );
}

function EvidenceCard({
  evidence,
  marker,
  expanded,
  flashing,
  onToggle,
}: {
  evidence: Evidence;
  marker: number | undefined;
  expanded: boolean;
  flashing: boolean;
  onToggle: () => void;
}) {
  const style = sourceStyle(evidence.source);
  const bodyId = `${evidenceDomId(evidence.evidenceId)}-body`;

  return (
    <li
      id={evidenceDomId(evidence.evidenceId)}
      className={`${style.className} animate-enter scroll-mt-24 rounded-xl border border-line bg-surface-2/60 shadow-[inset_3px_0_0_0_var(--accent)] transition-colors duration-200 hover:border-line-strong ${
        flashing ? 'cite-target' : ''
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={bodyId}
        className="w-full rounded-xl p-3.5 pl-4 text-left"
      >
        <div className="flex items-start gap-3">
          {/* Numbered only when the answer cited it. The number is the citation
              marker from the API, never this card's position — synthesis re-ranks
              evidence by distance before numbering it. */}
          {marker !== undefined ? (
            <span
              className="mt-px flex size-6 shrink-0 items-center justify-center rounded-md border border-signal/40 bg-signal/14 font-mono text-xs font-medium text-signal"
              title={`Cited as [${marker}]`}
            >
              {marker}
            </span>
          ) : (
            <span className="mt-px size-6 shrink-0" aria-hidden />
          )}

          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-sm leading-snug font-medium text-fg">
              {evidence.title}
            </p>
            <p className="mt-0.5 truncate font-mono text-xs text-faint">
              {evidence.docId ?? evidence.evidenceId}
            </p>
          </div>

          <ChevronDown
            className={`mt-0.5 size-4 shrink-0 text-muted transition-transform duration-200 ${
              expanded ? 'rotate-180' : ''
            }`}
            aria-hidden
          />
        </div>

        {!expanded && (
          <p className="mt-2.5 line-clamp-2 pl-9 text-sm leading-relaxed text-muted">
            {evidence.text}
          </p>
        )}
      </button>

      {expanded && (
        <div id={bodyId} className="border-t border-line px-4 pt-3 pb-4 sm:pl-[3.25rem]">
          <p className="max-h-80 overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap text-fg-2">
            {evidence.text}
          </p>
          {/* The numbers live here, behind a click: "distance", not "score", because
              lower is better and a score would be read the other way round. */}
          <p
            className="mt-3 font-mono text-xs text-faint tabular-nums"
            title="Vector distance — lower is more similar"
          >
            {evidence.evidenceId} · distance {evidence.distance.toFixed(3)} · {evidence.retrievedBy}{' '}
            via {evidence.tool}
          </p>
        </div>
      )}
    </li>
  );
}

function groupBySource(evidence: Evidence[]) {
  const bySource = new Map<CorpusSource | 'unknown', Evidence[]>();

  for (const item of evidence) {
    const key = item.source ?? 'unknown';
    const bucket = bySource.get(key);
    if (bucket) bucket.push(item);
    else bySource.set(key, [item]);
  }

  // Known sources first, in their fixed order, then anything else in the order it
  // arrived. Filtering by SOURCE_ORDER alone would *drop* evidence from a source
  // this build has not heard of — the same failure the closed `CorpusSource`
  // union used to cause in `sourceStyle`, except silent: the citation would
  // still resolve and the passage behind it would simply not be on screen.
  const extra = [...bySource.keys()].filter((source) => !SOURCE_ORDER.includes(source));

  return [...SOURCE_ORDER.filter((source) => bySource.has(source)), ...extra].map((source) => ({
    source,
    // Best evidence first inside a group; distance is lower-is-better.
    evidence: [...bySource.get(source)!].sort((a, b) => a.distance - b.distance),
  }));
}

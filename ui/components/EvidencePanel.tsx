'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CorpusSource, Evidence } from '@/lib/agent-events';
import { markersByEvidenceId, type RunView } from '@/lib/run-state';
import { relevanceFraction, sourceStyle } from '@/lib/presentation';
import { SourceBadge } from './SourceBadge';

export function evidenceDomId(evidenceId: string): string {
  return `evidence-${evidenceId}`;
}

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
  const groups = useMemo(() => groupBySource(view.evidence), [view.evidence]);

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
      // record that this jump was dismissed — otherwise "−" would do nothing.
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

  return (
    <section className="panel">
      <div className="panel-heading">
        <span>Evidence</span>
        <span className="font-normal normal-case text-ink-500">
          {view.evidence.length === 0
            ? 'none yet'
            : `${view.evidence.length} chunks · ${groups.length} source${
                groups.length === 1 ? '' : 's'
              }`}
        </span>
      </div>

      <div className="space-y-5 p-3 sm:p-4">
        {view.evidence.length === 0 && (
          <p className="font-mono text-xs text-ink-700">nothing retrieved yet…</p>
        )}

        {groups.map((group) => (
          <div key={group.source}>
            <div className="mb-2 flex items-center gap-2">
              <SourceBadge source={group.source === 'unknown' ? null : group.source} />
              <span className="font-mono text-[0.65rem] text-ink-700">
                {group.evidence.length} chunk{group.evidence.length === 1 ? '' : 's'}
              </span>
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
        ))}
      </div>
    </section>
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

  return (
    <li
      id={evidenceDomId(evidence.evidenceId)}
      className={`${style.className} scroll-mt-4 rounded-lg border border-white/8 bg-ink-900/50 ${
        flashing ? 'cite-target' : ''
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full p-3 text-left"
      >
        <div className="flex items-start gap-2.5">
          {/* Numbered only when the answer cited it. The number is the citation
              marker from the API, never this card's position — synthesis re-ranks
              evidence by distance before numbering it. */}
          {marker !== undefined ? (
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border border-signal/50 bg-signal/15 font-mono text-[0.65rem] text-signal">
              {marker}
            </span>
          ) : (
            <span className="mt-0.5 size-5 shrink-0" aria-hidden />
          )}

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink-100">{evidence.title}</p>
            <p className="truncate font-mono text-[0.65rem] text-ink-700">
              {evidence.docId ?? evidence.evidenceId}
            </p>
          </div>

          <span className="shrink-0 font-mono text-[0.6rem] text-ink-700">
            {expanded ? '−' : '+'}
          </span>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-ink-950/70">
            <div
              className="h-full rounded-full bg-[var(--accent)]"
              style={{ width: `${relevanceFraction(evidence.distance) * 100}%` }}
            />
          </div>
          {/* Labelled "distance", not "score": lower is better, and calling it a
              score would invite reading the bar backwards. */}
          <span
            className="shrink-0 font-mono text-[0.6rem] text-ink-700"
            title="Vector distance — lower is more similar"
          >
            d {evidence.distance.toFixed(3)}
          </span>
          <span className="shrink-0 font-mono text-[0.6rem] text-ink-700">
            {evidence.retrievedBy}
          </span>
        </div>

        {!expanded && (
          <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-ink-500">{evidence.text}</p>
        )}
      </button>

      {expanded && (
        <div className="border-t border-white/8 px-3 pt-2.5 pb-3">
          <p className="max-h-80 overflow-y-auto text-xs leading-relaxed whitespace-pre-wrap text-ink-300">
            {evidence.text}
          </p>
          <p className="mt-2 font-mono text-[0.6rem] text-ink-700">
            {evidence.evidenceId} · retrieved by {evidence.tool}
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

  return SOURCE_ORDER.filter((source) => bySource.has(source)).map((source) => ({
    source,
    // Best evidence first inside a group; distance is lower-is-better.
    evidence: [...bySource.get(source)!].sort((a, b) => a.distance - b.distance),
  }));
}

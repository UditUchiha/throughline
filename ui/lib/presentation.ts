import { KNOWN_SOURCES, type CorpusSource, type KnownSource } from './agent-events';
import type { KnownCategory, QuestionCategory } from './api';

export interface SourceStyle {
  label: string;
  className: string;
}

/**
 * Source identity is the spine of the visual language.
 *
 * The premise of the project is evidence scattered across mail, chat and notes,
 * so one colour per source is used *everywhere* it appears — tool bar, evidence
 * card, badge. A visitor learns three colours once and can then read the fan-out
 * without reading any labels.
 */
export const SOURCE_STYLES: Record<KnownSource, SourceStyle> = {
  mail: { label: 'mail', className: 'source-mail' },
  chat: { label: 'chat', className: 'source-chat' },
  notes: { label: 'notes', className: 'source-notes' },
};

/** Neutral styling for the cross-source tool and for evidence with no source. */
export const NEUTRAL_SOURCE: SourceStyle = { label: 'all sources', className: 'source-all' };

/**
 * Which source a tool searches. Derived from the tool name rather than looked up,
 * because the registry is not exposed over HTTP and M5's connectors added tools
 * this UI has never heard of — `obsidian_search_notes` among them. Those fall
 * through to neutral here rather than breaking. The evidence they return still
 * carries a real `source`, so the cards are coloured even when the tool bar is
 * not.
 */
export function sourceForTool(tool: string): CorpusSource | null {
  if (tool.startsWith('mail')) return 'mail';
  if (tool.startsWith('chat')) return 'chat';
  if (tool.startsWith('notes')) return 'notes';
  return null;
}

/**
 * Never returns undefined.
 *
 * `SOURCE_STYLES[source]` used to be indexed by a closed union, so a source the
 * API added — an M5 connector filing under something other than mail/chat/notes
 * — produced `undefined` and then threw on `.className` in the evidence panel.
 * A source this build has no colour for is styled neutrally and labelled with
 * its own name, which is the same treatment `categoryLabel` gives an unknown
 * question category.
 */
export function sourceStyle(source: CorpusSource | null): SourceStyle {
  if (!source) return NEUTRAL_SOURCE;

  const known = KNOWN_SOURCES.find((candidate) => candidate === source);
  return known ? SOURCE_STYLES[known] : { label: source, className: NEUTRAL_SOURCE.className };
}

/**
 * What each question category is here to demonstrate.
 *
 * PLAN.md §5/M2 is specific about this: label examples by the behaviour they
 * provoke, not by their taxonomy. "Should refuse to answer" is an invitation to
 * watch the system decline; "unanswerable" is a filing category.
 */
const CATEGORY_LABELS: Record<KnownCategory, string> = {
  'single-hop': 'one source, one fact',
  'multi-hop': 'needs 2 sources',
  temporal: 'a fact that changed',
  distractor: 'has a decoy answer',
  unanswerable: 'should refuse to answer',
  adversarial: 'evidence tries to hijack it',
};

/**
 * Falls back to the raw category rather than rendering an empty chip. The API
 * owns this vocabulary and can add to it; a UI deployed before that happens
 * should say "seasonal" rather than nothing at all.
 */
export function categoryLabel(category: QuestionCategory): string {
  return CATEGORY_LABELS[category as KnownCategory] ?? category;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

export function formatTokens(count: number | null | undefined): string {
  if (count === null || count === undefined) return '—';
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

export function formatCost(costUsd: number | null): string {
  // The API returns null when any call in the run was unpriced, and a run costing
  // "$0.00" is a different claim from one whose cost is unknown.
  return costUsd === null ? 'not priced' : `$${costUsd.toFixed(4)}`;
}

/**
 * Distance is a raw vector distance: **lower is more similar**, and it is not
 * normalised to 0–1. Rendering it directly as a bar would show the best evidence
 * as the weakest, so this inverts it against the band the corpus actually
 * occupies, purely to make the bars comparable. The number beside the bar stays
 * the real distance.
 *
 * The band is **measured, not guessed**: across the 55 retrieved chunks in
 * `fixtures/runs/*.json` the range is 0.406–0.585 on `gemini-embedding-001` at
 * 768d. `WORST` sits above that with headroom rather than at the observed
 * maximum, so a genuinely poor hit still reads as poor instead of pinning the
 * scale. An earlier 0.4–0.75 window squeezed every real bar into the top half
 * of the track, which wastes the one control whose whole job is showing
 * differences.
 *
 * **These constants are specific to the embedding model.** Distances are not
 * comparable across models, so changing `EMBEDDING_MODEL` means re-measuring
 * them — the same portability trap documented for `RETRIEVAL_DISTANCE_THRESHOLD`
 * in `docs/retrieval-threshold-study.md`.
 */
const BEST_DISTANCE = 0.4;
const WORST_DISTANCE = 0.65;

export function relevanceFraction(distance: number): number {
  const clamped = Math.min(Math.max(distance, BEST_DISTANCE), WORST_DISTANCE);
  const fraction = 1 - (clamped - BEST_DISTANCE) / (WORST_DISTANCE - BEST_DISTANCE);
  // A chunk past the band was still retrieved and still cited; a zero-width bar
  // reads as a rendering fault rather than as weak evidence.
  return Math.max(fraction, 0.04);
}

export function formatCapturedAt(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

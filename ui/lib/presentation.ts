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

/** What `ConnectionBanner` is telling the visitor, and why. */
export type ConnectionCause = 'local-dev' | 'rate-limited' | 'no-response' | 'api-error';

/**
 * Classifies a failed request into the one thing that actually decides what to
 * tell the visitor, pulled out of `ConnectionBanner` so it is testable without a
 * DOM — the same reason `sourceStyle` and `categoryLabel` live here rather than
 * inline in a component.
 *
 * This exists because the component used to have no such classification: every
 * non-local failure got one sentence — "runs on a free tier that sleeps" —
 * regardless of what actually happened. Confirmed live on 2026-09-20: a visitor
 * who spent the 5-per-10-minute budget saw that sentence sitting directly under
 * `ThrottlerException: Too Many Requests`, contradicting it — the instance was
 * warm the whole time. `status` is `null` only when the request never got a
 * response at all (DNS, a refused connection, a CORS preflight the browser
 * blocked); `local` takes precedence over both, since local dev advice ("start
 * it with pnpm start:dev") is only ever right against a local API regardless of
 * how the request failed.
 */
export function connectionCause(local: boolean, status: number | null): ConnectionCause {
  if (local) return 'local-dev';
  if (status === 429) return 'rate-limited';
  if (status === null) return 'no-response';
  return 'api-error';
}

export function formatCapturedAt(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

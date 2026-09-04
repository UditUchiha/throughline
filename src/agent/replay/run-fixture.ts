import type { EmittedAgentEvent } from '../events';

/**
 * A run captured from a live agent and written to disk.
 *
 * The events are exactly what went over the wire, so replaying one exercises the
 * consumer's real code path rather than a parallel "demo mode" that drifts from
 * production behaviour.
 */
export interface RunFixture {
  /** Stable file-name-safe identifier, derived from the file name. */
  slug: string;
  question: string;
  capturedAt: string;
  /** What this fixture is here to demonstrate — shown in the examples list. */
  label?: string;
  events: EmittedAgentEvent[];
}

/** The subset a UI needs to render an example-question list. */
export interface RunFixtureSummary {
  slug: string;
  question: string;
  label?: string;
  capturedAt: string;
  /** Wall-clock duration of the original run, for an honest "~Ns" hint. */
  durationMs: number;
  eventCount: number;
}

export function isRunFixture(value: unknown): value is Omit<RunFixture, 'slug'> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<RunFixture>;
  return (
    typeof candidate.question === 'string' &&
    typeof candidate.capturedAt === 'string' &&
    Array.isArray(candidate.events)
  );
}

/**
 * Original spacing between events, so a replay paces like the real thing instead
 * of dumping everything at once. Gaps are clamped because a captured run that
 * stalled on a slow provider should not make the demo stall too.
 */
export function eventDelaysMs(events: EmittedAgentEvent[], maxGapMs: number): number[] {
  return events.map((event, i) => {
    if (i === 0) return 0;
    const previous = Date.parse(events[i - 1].ts);
    const current = Date.parse(event.ts);
    if (Number.isNaN(previous) || Number.isNaN(current)) return 0;
    return Math.min(Math.max(current - previous, 0), maxGapMs);
  });
}

export function fixtureDurationMs(events: EmittedAgentEvent[]): number {
  if (events.length < 2) return 0;
  const first = Date.parse(events[0].ts);
  const last = Date.parse(events[events.length - 1].ts);
  return Number.isNaN(first) || Number.isNaN(last) ? 0 : Math.max(last - first, 0);
}

/** Questions are matched loosely so a UI need not echo punctuation exactly. */
export function normaliseQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

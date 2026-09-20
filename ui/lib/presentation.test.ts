import { describe, expect, it } from 'vitest';
import {
  connectionCause,
  NEUTRAL_SOURCE,
  SOURCE_STYLES,
  sourceForTool,
  sourceStyle,
} from './presentation';

/**
 * These exist because of a specific near-miss in M5.
 *
 * `CorpusSource` was a closed union and `sourceStyle` was `SOURCE_STYLES[source]`,
 * so a source the API added — a connector filing its results under something
 * other than mail/chat/notes — would have produced `undefined` and thrown on
 * `.className` inside the evidence panel. A hard crash in the UI, caused by a
 * value the API is entitled to send. Same bug class as `QuestionCategory`, whose
 * fix was keeping the type open; the type is now open here too, and this is the
 * runtime half of that fix.
 */
describe('sourceStyle', () => {
  it('styles the three sources this build knows', () => {
    expect(sourceStyle('mail')).toEqual(SOURCE_STYLES.mail);
    expect(sourceStyle('notes')).toEqual(SOURCE_STYLES.notes);
  });

  it('falls back to neutral for evidence with no source', () => {
    expect(sourceStyle(null)).toEqual(NEUTRAL_SOURCE);
  });

  it('labels an unknown source with its own name rather than crashing', () => {
    const style = sourceStyle('gmail');

    expect(style).toBeDefined();
    expect(style.label).toBe('gmail');
    expect(style.className).toBe(NEUTRAL_SOURCE.className);
  });
});

describe('sourceForTool', () => {
  it('maps the corpus tools to their source', () => {
    expect(sourceForTool('mail_search')).toBe('mail');
    expect(sourceForTool('notes_search')).toBe('notes');
  });

  // Connector tools are named after their server, not their source, so they land
  // here. Neutral is correct: the evidence cards still carry the real source.
  it('leaves a connector tool neutral instead of guessing', () => {
    expect(sourceForTool('obsidian_search_notes')).toBeNull();
  });
});

/**
 * These exist because of a live near-miss, not a hypothetical.
 *
 * `ConnectionBanner` used to show one sentence — "runs on a free tier that
 * sleeps after 15 idle minutes" — for every non-local failure. Confirmed live
 * on 2026-09-20: a visitor who spent the 5-per-10-minute budget saw that
 * sentence directly beside `ThrottlerException: Too Many Requests`, and the two
 * contradict each other — the instance was warm the whole time. `status` is
 * what a rate limit and a cold-start-shaped network failure can be told apart
 * by, and this is the classification, pinned so the four causes cannot collapse
 * back into one sentence by accident.
 */
describe('connectionCause', () => {
  it('is local-dev whenever the API is local, regardless of status', () => {
    expect(connectionCause(true, null)).toBe('local-dev');
    expect(connectionCause(true, 429)).toBe('local-dev');
    expect(connectionCause(true, 500)).toBe('local-dev');
  });

  it('is rate-limited on a 429 against a deployed API', () => {
    expect(connectionCause(false, 429)).toBe('rate-limited');
  });

  it('is no-response when the request never got one back', () => {
    // `null` is what a DNS failure, a refused connection or a blocked CORS
    // preflight all look like to `fetch` — there was no status to report.
    expect(connectionCause(false, null)).toBe('no-response');
  });

  it('is api-error for any other status, rather than guessing a cold start', () => {
    expect(connectionCause(false, 400)).toBe('api-error');
    expect(connectionCause(false, 500)).toBe('api-error');
    expect(connectionCause(false, 404)).toBe('api-error');
  });
});

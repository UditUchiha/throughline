import { describe, expect, it } from 'vitest';
import { NEUTRAL_SOURCE, SOURCE_STYLES, sourceForTool, sourceStyle } from './presentation';

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

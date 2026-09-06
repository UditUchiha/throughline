import { CORPUS_SOURCES, isCorpusSource } from './knowledge.types';

/**
 * `CorpusSource` used to be a bare union with the same three strings restated in
 * a `Set` in the loader and a `z.enum` in the examples projection. Adding a
 * source meant three edits, and forgetting one failed silently: an unrecognised
 * source became `null`, and the document was indexed unfiltered rather than
 * rejected — invisible until `planSourceCoverage` moved.
 *
 * The list is now the single declaration the type is derived from, and this is
 * what stops a cast creeping back in.
 */
describe('isCorpusSource', () => {
  it('accepts every declared source', () => {
    for (const source of CORPUS_SOURCES) {
      expect(isCorpusSource(source)).toBe(true);
    }
  });

  it('rejects a string that is not one', () => {
    // The realistic cases: a connector namespace, a plural, a different case.
    expect(isCorpusSource('slack')).toBe(false);
    expect(isCorpusSource('emails')).toBe(false);
    expect(isCorpusSource('Mail')).toBe(false);
    expect(isCorpusSource('')).toBe(false);
  });

  it('rejects non-strings, because a database column can hold anything', () => {
    // `chunks.source` is TEXT with no CHECK constraint, and `better-sqlite3`
    // hands back whatever is in the row.
    expect(isCorpusSource(null)).toBe(false);
    expect(isCorpusSource(undefined)).toBe(false);
    expect(isCorpusSource(1)).toBe(false);
    expect(isCorpusSource(['mail'])).toBe(false);
    expect(isCorpusSource({ source: 'mail' })).toBe(false);
  });

  it('narrows the type, so callers need no cast', () => {
    const value: unknown = 'chat';
    if (isCorpusSource(value)) {
      // Compiles only because the guard narrowed `unknown` to `CorpusSource`.
      const narrowed: 'mail' | 'chat' | 'notes' = value;
      expect(narrowed).toBe('chat');
    } else {
      throw new Error('guard should have accepted "chat"');
    }
  });

  it('still describes the corpus on disk', () => {
    // A source added here without a matching directory under corpus/generated
    // would be declared and never populated; one added there without this entry
    // would load as `null`. Both are drift the ledger cannot see.
    expect([...CORPUS_SOURCES]).toEqual(['mail', 'chat', 'notes']);
  });
});

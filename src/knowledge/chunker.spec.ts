import { chunkText } from './chunker';

/**
 * `chunkText` had no tests because the current corpus never exercises it: the
 * default window is 700 *words* and every generated document fits in one, so
 * retrieval is whole-document and a broken chunker would look exactly like a
 * working one. That is precisely why it is worth pinning — the first thing to
 * change it will be M5's connectors, which carry documents long enough to split,
 * and by then the evidence that it was ever correct would be gone.
 *
 * The units are the trap the module's own comment names: `CHUNK_SIZE` reads like
 * characters and is words.
 */
describe('chunkText', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

  it('counts words, not characters', () => {
    // 10 words is ~38 characters. A character-based splitter would produce
    // several chunks here; a word-based one produces exactly two.
    expect(chunkText(words(10), 5, 0)).toEqual(['w0 w1 w2 w3 w4', 'w5 w6 w7 w8 w9']);
  });

  it('returns a document shorter than the window as a single chunk', () => {
    // The whole current corpus takes this path.
    expect(chunkText('a short note', 700, 100)).toEqual(['a short note']);
  });

  it('returns nothing for text with no words rather than one empty chunk', () => {
    // An empty chunk would be embedded and indexed, and would then be retrievable
    // as a passage containing nothing.
    expect(chunkText('', 10, 2)).toEqual([]);
    expect(chunkText('   \n\t  ', 10, 2)).toEqual([]);
  });

  it('overlaps consecutive windows by chunkOverlap words', () => {
    const chunks = chunkText(words(10), 5, 2);

    // step = 5 - 2 = 3, so windows start at 0, 3, 6 and the last one is short.
    expect(chunks).toEqual(['w0 w1 w2 w3 w4', 'w3 w4 w5 w6 w7', 'w6 w7 w8 w9']);
    // The overlap is the point: a sentence spanning a boundary survives in one
    // of the two windows intact.
    expect(chunks[0].split(' ').slice(-2)).toEqual(chunks[1].split(' ').slice(0, 2));
  });

  it('terminates when overlap is greater than or equal to the window', () => {
    // step would be 0 or negative, which is an infinite loop rather than a bad
    // chunking. `Math.max(..., 1)` is the guard, and this is the assertion that
    // it is still there — the failure mode is a hung boot, not a test failure
    // somewhere else.
    expect(chunkText(words(6), 3, 3)).toEqual(['w0 w1 w2', 'w1 w2 w3', 'w2 w3 w4', 'w3 w4 w5']);
    expect(chunkText(words(4), 2, 9)).toHaveLength(3);
  });

  it('normalises runs of whitespace, so a chunk is words joined by single spaces', () => {
    expect(chunkText('one\n\ntwo\t three   four', 2, 0)).toEqual(['one two', 'three four']);
  });

  it('emits no trailing chunk that repeats only text already covered', () => {
    // 6 words, window 4, step 2: windows at 0 and 2 cover everything, and the
    // loop must stop rather than emitting a third starting at 4.
    expect(chunkText(words(6), 4, 2)).toEqual(['w0 w1 w2 w3', 'w2 w3 w4 w5']);
  });
});

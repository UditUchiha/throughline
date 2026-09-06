import { z } from 'zod';
import { parseJsonObject } from './structured-output';

/**
 * A model's reply is the least trustworthy input in the system, and it was the
 * only one not validated: `parseJsonObject` returned `parsed as T`, so every
 * field was a shape the caller named and nobody checked.
 *
 * The extraction half (fences, prose preambles) already worked and is pinned
 * here so the fix does not quietly cost the tolerance it was written for. The
 * validation half is new, and the cases below are the ones that used to reach a
 * `TypeError` inside a node — see each node's schema for which line.
 */
describe('parseJsonObject', () => {
  const schema = z.object({
    answer: z.string().optional(),
    items: z.array(z.object({ text: z.string().optional() })).catch([]),
  });

  describe('extraction — unchanged behaviour', () => {
    it('reads a bare JSON object', () => {
      expect(parseJsonObject('{"answer":"yes","items":[]}', schema)).toEqual({
        answer: 'yes',
        items: [],
      });
    });

    it('reads an object inside a ```json fence', () => {
      const text = '```json\n{"answer":"fenced","items":[]}\n```';

      expect(parseJsonObject(text, schema)?.answer).toBe('fenced');
    });

    it('reads an object inside an unlabelled fence', () => {
      expect(parseJsonObject('```\n{"answer":"bare fence","items":[]}\n```', schema)?.answer).toBe(
        'bare fence',
      );
    });

    it('reads an object after a chatty preamble', () => {
      const text = 'Sure! Here is the result:\n{"answer":"after prose","items":[]}';

      expect(parseJsonObject(text, schema)?.answer).toBe('after prose');
    });

    it('returns null for text with no JSON in it at all', () => {
      expect(parseJsonObject('I am afraid I cannot help with that.', schema)).toBeNull();
    });

    it('returns null for a JSON value that is not an object', () => {
      expect(parseJsonObject('"just a string"', schema)).toBeNull();
      expect(parseJsonObject('42', schema)).toBeNull();
    });
  });

  describe('validation — the hole the cast left', () => {
    it('rejects a field of the wrong type instead of passing it on', () => {
      // `{"answer": 3}` used to satisfy `if (!parsed?.answer)` and then reach a
      // regex in `resolveCitations`.
      expect(parseJsonObject('{"answer":3,"items":[]}', schema)).toBeNull();
    });

    it('degrades an array-shaped field that is not an array', () => {
      // The plan node's crash: `.slice()` works on a string and `.map()` does
      // not, so `{"subQuestions":"sq1, sq2"}` failed at the last step.
      expect(parseJsonObject('{"answer":"a","items":"sq1, sq2"}', schema)).toEqual({
        answer: 'a',
        items: [],
      });
    });

    it('degrades an array whose elements are the wrong shape', () => {
      expect(parseJsonObject('{"answer":"a","items":[1,2,3]}', schema)?.items).toEqual([]);
    });

    it('keeps a valid response whose optional fields are absent', () => {
      // Partial responses must survive — the nodes have defaults for each field
      // and requiring them would discard the half that arrived.
      expect(parseJsonObject('{"items":[]}', schema)).toEqual({ items: [] });
    });

    it('ignores fields the schema does not mention', () => {
      // Models add commentary keys. Rejecting them would fail a usable response.
      const parsed = parseJsonObject('{"answer":"a","items":[],"note":"extra"}', schema);

      expect(parsed).toEqual({ answer: 'a', items: [] });
    });

    it('prefers a later candidate that validates over an earlier one that only parses', () => {
      // A provider can emit an unrelated object first and the real answer in a
      // fence after it. Validating per candidate is what finds the second.
      const text = '{"unrelated":true,"answer":5}\n```json\n{"answer":"real","items":[]}\n```';

      expect(parseJsonObject(text, schema)?.answer).toBe('real');
    });
  });
});

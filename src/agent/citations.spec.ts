import type { Evidence } from './agent.types';
import {
  mintEvidenceId,
  renderEvidenceBlock,
  resolveCitations,
  stripUnresolvedMarkers,
} from './citations';

function evidence(chunkId: number, text: string): Evidence {
  return {
    evidenceId: mintEvidenceId(chunkId),
    docId: `doc-${chunkId}`,
    source: 'mail',
    title: `Title ${chunkId}`,
    text,
    distance: 0.1,
    retrievedBy: 'sq1',
    tool: 'mail_search',
  };
}

describe('citations', () => {
  describe('resolveCitations', () => {
    it('maps every marker to the evidence it was numbered with', () => {
      const { ordering } = renderEvidenceBlock([evidence(7, 'a'), evidence(9, 'b')]);

      const { citations, unresolved } = resolveCitations(
        'Ship slipped [1]. Priya agreed [2].',
        ordering,
      );

      expect(unresolved).toEqual([]);
      expect(citations).toEqual([
        { marker: 1, evidenceId: 'ev-7' },
        { marker: 2, evidenceId: 'ev-9' },
      ]);
    });

    // The deterministic guarantee M1 rests on: the model cannot cite evidence it
    // was never shown, because a marker out of range resolves to nothing.
    it('rejects a fabricated marker instead of inventing an evidenceId', () => {
      const { ordering } = renderEvidenceBlock([evidence(7, 'a')]);

      const { citations, unresolved } = resolveCitations('Claim [1]. Fabricated [4].', ordering);

      expect(citations).toEqual([{ marker: 1, evidenceId: 'ev-7' }]);
      expect(unresolved).toEqual([4]);
    });

    it('deduplicates a marker cited more than once', () => {
      const { ordering } = renderEvidenceBlock([evidence(7, 'a')]);

      const { citations } = resolveCitations('One [1]. Two [1].', ordering);

      expect(citations).toHaveLength(1);
    });

    it('resolves nothing when no evidence was shown', () => {
      const { citations, unresolved } = resolveCitations('Unsupported [1].', []);

      expect(citations).toEqual([]);
      expect(unresolved).toEqual([1]);
    });
  });

  describe('stripUnresolvedMarkers', () => {
    it('removes only the dangling markers', () => {
      expect(stripUnresolvedMarkers('Kept [1]. Dropped [4].', [4])).toBe('Kept [1]. Dropped .');
    });

    it('leaves text untouched when everything resolved', () => {
      expect(stripUnresolvedMarkers('Kept [1].', [])).toBe('Kept [1].');
    });
  });

  describe('renderEvidenceBlock', () => {
    it('numbers passages from 1 and never exposes an evidenceId to the model', () => {
      const { text, ordering } = renderEvidenceBlock([evidence(7, 'alpha'), evidence(9, 'beta')]);

      expect(text).toContain('[1] (mail · doc-7) Title 7');
      expect(text).toContain('[2] (mail · doc-9) Title 9');
      expect(text).not.toContain('ev-7');
      expect(ordering).toEqual(['ev-7', 'ev-9']);
    });
  });

  describe('mintEvidenceId', () => {
    // Concurrent sub-questions retrieving the same chunk must agree on its id,
    // otherwise the same passage is cited twice under different numbers.
    it('is derived from the chunk, so the same chunk always gets the same id', () => {
      expect(mintEvidenceId(42)).toBe(mintEvidenceId(42));
      expect(mintEvidenceId(42)).not.toBe(mintEvidenceId(43));
    });
  });
});

import { mintEvidenceId } from '../../agent/citations';
import {
  calibrateDistance,
  relevanceFromRank,
  toRetrievedChunks,
  type McpToolResult,
} from './mcp-results';

const options = { namespace: 'obsidian', source: 'notes' as const, topK: 5 };

describe('calibrateDistance', () => {
  it('maps better relevance to a smaller distance', () => {
    expect(calibrateDistance(1)).toBeLessThan(calibrateDistance(0));
  });

  // The band is deliberately not the corpus's best. A connector's top hit should
  // compete with good corpus evidence, not automatically outrank all of it —
  // `synthesize` sorts on this one number across every tool.
  it('keeps a connector inside the measured corpus band rather than beneath it', () => {
    expect(calibrateDistance(1)).toBeGreaterThan(0.406);
    expect(calibrateDistance(0)).toBeLessThan(0.65);
  });

  it('clamps a score outside 0..1 rather than inventing a distance off the scale', () => {
    expect(calibrateDistance(4)).toBe(calibrateDistance(1));
    expect(calibrateDistance(-4)).toBe(calibrateDistance(0));
  });
});

describe('relevanceFromRank', () => {
  // Being first out of one is not evidence of quality — there was nothing to be
  // ranked against. Awarding the top of the band is how a weak lone match
  // outranks good corpus evidence in the synthesis prompt.
  it('places a lone unscored result mid-band rather than at the top', () => {
    expect(relevanceFromRank(0, 1)).toBe(0.5);
    expect(calibrateDistance(relevanceFromRank(0, 1))).toBeGreaterThan(calibrateDistance(1));
  });

  it('descends with position', () => {
    expect(relevanceFromRank(0, 3)).toBeGreaterThan(relevanceFromRank(2, 3));
  });
});

describe('toRetrievedChunks', () => {
  it('reads structuredContent results, keeping the server’s own scores', () => {
    const result: McpToolResult = {
      structuredContent: {
        results: [
          { path: 'Projects/Helios.md', title: 'Helios', text: 'billing migration', score: 1 },
          { path: 'Inbox/Scratch.md', title: 'Scratch', text: 'unsorted', score: 0.2 },
        ],
      },
    };

    const chunks = toRetrievedChunks(result, options);

    expect(chunks).toHaveLength(2);
    expect(chunks[0].articleTitle).toBe('Helios');
    expect(chunks[0].distance).toBeLessThan(chunks[1].distance);
    expect(chunks[0].source).toBe('notes');
  });

  // The sharpest failure this milestone could have shipped: `mergeEvidence` in
  // state.ts dedupes by evidenceId, so a connector minting `1` would silently
  // erase corpus chunk 1 (or be erased by it) and a citation would resolve to
  // the wrong passage. Namespacing is what keeps the two id spaces disjoint.
  it('mints evidence ids that cannot collide with a corpus chunk id', () => {
    const chunks = toRetrievedChunks(
      { structuredContent: { results: [{ id: '1', text: 'first result' }] } },
      options,
    );

    expect(chunks[0].chunkId).toBe('obsidian:1');
    expect(mintEvidenceId(chunks[0].chunkId)).toBe('ev-obsidian:1');
    expect(mintEvidenceId(chunks[0].chunkId)).not.toBe(mintEvidenceId(1));
  });

  it('falls back to text content blocks when there is no structured output', () => {
    const result: McpToolResult = {
      content: [
        { type: 'text', text: 'first passage' },
        { type: 'image', data: 'ignored' },
        { type: 'text', text: 'second passage' },
      ],
    };

    const chunks = toRetrievedChunks(result, options);

    expect(chunks.map((chunk) => chunk.text)).toEqual(['first passage', 'second passage']);
  });

  it('derives a stable id from the text when the server supplies none', () => {
    const once = toRetrievedChunks({ content: [{ type: 'text', text: 'same' }] }, options);
    const twice = toRetrievedChunks({ content: [{ type: 'text', text: 'same' }] }, options);

    expect(once[0].chunkId).toBe(twice[0].chunkId);
  });

  // Empty and failed are different outcomes, and `tool_finished.error` is the
  // only thing that distinguishes them for a consumer. Swallowing the error
  // would render a broken connector as a search that found nothing.
  it('throws on an error result rather than returning no evidence', () => {
    expect(() =>
      toRetrievedChunks(
        { isError: true, content: [{ type: 'text', text: 'vault not found' }] },
        options,
      ),
    ).toThrow('vault not found');
  });

  // The regression this file exists for. An empty structured list used to fall
  // through to the text blocks, turning a server's human-facing "no results"
  // prose into the run's single best-ranked passage — silently, because
  // `isError` is false and the tool reports success.
  it('returns nothing for an explicitly empty result set, rather than the miss message', () => {
    const chunks = toRetrievedChunks(
      {
        structuredContent: { results: [] },
        content: [{ type: 'text', text: 'No matching notes.' }],
      },
      options,
    );

    expect(chunks).toEqual([]);
  });

  it('still falls through to text blocks when the structured shape is unreadable', () => {
    const chunks = toRetrievedChunks(
      {
        structuredContent: { results: [{ path: 'a.md' }] },
        content: [{ type: 'text', text: 'the real content' }],
      },
      options,
    );

    expect(chunks.map((chunk) => chunk.text)).toEqual(['the real content']);
  });

  it('caps results at topK so one chatty server cannot flood the prompt', () => {
    const results = Array.from({ length: 20 }, (_unused, i) => ({
      id: `n${i}`,
      text: `note ${i}`,
    }));

    const chunks = toRetrievedChunks({ structuredContent: { results } }, { ...options, topK: 3 });

    expect(chunks).toHaveLength(3);
  });

  it('reports no article id rather than fabricating one', () => {
    const chunks = toRetrievedChunks({ content: [{ type: 'text', text: 'passage' }] }, options);

    expect(chunks[0].articleId).toBeNull();
  });
});

import { ConflictScanner } from './conflict-scanner.service';
import type { ConflictJudge } from './conflict-judge.service';
import type { Chunk } from '../common/types/knowledge.types';
import type { ChunkRepository } from '../repositories/ports/chunk.repository';
import type {
  EmbeddingRepository,
  EmbeddingSearchHit,
} from '../repositories/ports/embedding.repository';
import type { Conflict, ConflictCandidate } from './conflict.types';

function chunk(id: number, docId: string | null, source: Chunk['source'] = 'notes'): Chunk {
  return { id, articleId: id, chunkIndex: 0, text: `body of ${docId ?? id}`, source, docId };
}

/**
 * Wires a scanner over fakes. `links` is the neighbour graph by chunk id, so a
 * test states the vector layout directly instead of staging embeddings.
 */
function buildScanner(options: {
  chunks: Chunk[];
  links: Record<number, number[]>;
  judge?: (candidate: ConflictCandidate) => Promise<Conflict[]>;
}) {
  const seen: ConflictCandidate[] = [];

  const chunkRepository = {
    findAll: () => Promise.resolve(options.chunks),
  } as unknown as ChunkRepository;

  const embeddingRepository = {
    neighbours: (chunkId: number, topK: number): Promise<EmbeddingSearchHit[]> =>
      Promise.resolve(
        (options.links[chunkId] ?? [])
          .slice(0, topK)
          .map((id, i) => ({ chunkId: id, distance: 0.3 + i * 0.01 })),
      ),
  } as unknown as EmbeddingRepository;

  const judge = {
    judge: (candidate: ConflictCandidate) => {
      seen.push(candidate);
      return options.judge ? options.judge(candidate) : Promise.resolve([]);
    },
  } as unknown as ConflictJudge;

  return { scanner: new ConflictScanner(chunkRepository, embeddingRepository, judge), seen };
}

function conflictBetween(outdated: string, current: string, topic = 'pricing'): Conflict {
  return {
    kind: 'superseded',
    topic,
    outdated: { docId: outdated, source: 'notes', claim: 'old' },
    current: { docId: current, source: 'notes', claim: 'new' },
    reasoning: 'dated later',
  };
}

describe('ConflictScanner', () => {
  describe('choosing what to compare', () => {
    it('pairs each document with its nearest neighbours', async () => {
      const { scanner, seen } = buildScanner({
        chunks: [chunk(1, 'a'), chunk(2, 'b'), chunk(3, 'c')],
        links: { 1: [2, 3], 2: [1], 3: [] },
      });

      await scanner.scan();

      expect(seen).toHaveLength(2);
      expect(seen[0].subject.docId).toBe('a');
      expect(seen[0].neighbours.map((n) => n.docId)).toEqual(['b', 'c']);
    });

    // Chunks of one document are near each other by construction, so without
    // this the chunker's own overlap surfaces as a finding about the corpus.
    it('never compares a document against another chunk of itself', async () => {
      const { scanner, seen } = buildScanner({
        chunks: [chunk(1, 'a'), chunk(2, 'a'), chunk(3, 'b')],
        links: { 1: [2, 3], 2: [1], 3: [1] },
      });

      await scanner.scan();

      expect(seen[0].neighbours.map((n) => n.docId)).toEqual(['b']);
    });

    // A document with every neighbour filtered away must not reach the judge:
    // that is a model call guaranteed to return nothing.
    it('raises no candidate, and spends nothing, when all neighbours are filtered out', async () => {
      const { scanner, seen } = buildScanner({
        chunks: [chunk(1, 'a'), chunk(2, 'a')],
        links: { 1: [2], 2: [1] },
      });

      const report = await scanner.scan();

      expect(seen).toEqual([]);
      expect(report.documentsScanned).toBe(0);
    });

    it('skips chunks that carry no document id, since a finding could not cite them', async () => {
      const { scanner, seen } = buildScanner({
        chunks: [chunk(1, 'a'), chunk(2, null), chunk(3, 'c')],
        links: { 1: [2, 3], 2: [1], 3: [1] },
      });

      await scanner.scan();

      expect(seen.map((c) => c.subject.docId)).toEqual(['a', 'c']);
      expect(seen[0].neighbours.map((n) => n.docId)).toEqual(['c']);
    });

    it('honours the neighbour count it is given', async () => {
      const { scanner, seen } = buildScanner({
        chunks: [chunk(1, 'a'), chunk(2, 'b'), chunk(3, 'c'), chunk(4, 'd')],
        links: { 1: [2, 3, 4] },
      });

      await scanner.scan({ neighbours: 2 });

      expect(seen[0].neighbours).toHaveLength(2);
    });

    it('scans only the documents named, matching by substring', async () => {
      const { scanner, seen } = buildScanner({
        chunks: [
          chunk(1, 'notes.pricing-v1'),
          chunk(2, 'notes.pricing-v2'),
          chunk(3, 'mail.other'),
        ],
        links: { 1: [2, 3], 2: [1], 3: [1] },
      });

      await scanner.scan({ docIds: ['pricing-v1'] });

      expect(seen.map((c) => c.subject.docId)).toEqual(['notes.pricing-v1']);
    });

    // Narrowing which documents are *judged* must not narrow what they are
    // judged against, or a targeted scan compares against a corpus that does
    // not exist and can miss the very conflict it was aimed at.
    it('still compares against the whole index when narrowed', async () => {
      const { scanner, seen } = buildScanner({
        chunks: [
          chunk(1, 'notes.pricing-v1'),
          chunk(2, 'notes.pricing-v2'),
          chunk(3, 'mail.other'),
        ],
        links: { 1: [2, 3] },
      });

      await scanner.scan({ docIds: ['pricing-v1'] });

      expect(seen[0].neighbours.map((n) => n.docId)).toEqual(['notes.pricing-v2', 'mail.other']);
    });

    it('bounds the sweep with limit, so a scan can be tried without paying for all of it', async () => {
      const { scanner, seen } = buildScanner({
        chunks: [chunk(1, 'a'), chunk(2, 'b'), chunk(3, 'c')],
        links: { 1: [2], 2: [1], 3: [1] },
      });

      const report = await scanner.scan({ limit: 2 });

      expect(seen).toHaveLength(2);
      expect(report.documentsScanned).toBe(2);
    });
  });

  describe('collecting findings', () => {
    // A and B are near-symmetric neighbours, so one disagreement is normally
    // judged twice — once from each end.
    it('reports a conflict once when both ends of the pair find it', async () => {
      const { scanner } = buildScanner({
        chunks: [chunk(1, 'a'), chunk(2, 'b')],
        links: { 1: [2], 2: [1] },
        judge: () => Promise.resolve([conflictBetween('a', 'b')]),
      });

      const report = await scanner.scan();

      expect(report.conflicts).toHaveLength(1);
    });

    it('keeps two disagreements between the same pair as two findings', async () => {
      const { scanner } = buildScanner({
        chunks: [chunk(1, 'a'), chunk(2, 'b')],
        links: { 1: [2], 2: [] },
        judge: () =>
          Promise.resolve([
            conflictBetween('a', 'b', 'pricing'),
            conflictBetween('a', 'b', 'owner'),
          ]),
      });

      const report = await scanner.scan();

      expect(report.conflicts.map((c) => c.topic).sort()).toEqual(['owner', 'pricing']);
    });

    it('treats the pair as unordered when deduping, so direction cannot double-count', async () => {
      let call = 0;
      const { scanner } = buildScanner({
        chunks: [chunk(1, 'a'), chunk(2, 'b')],
        links: { 1: [2], 2: [1] },
        judge: () =>
          Promise.resolve([call++ === 0 ? conflictBetween('a', 'b') : conflictBetween('b', 'a')]),
      });

      const report = await scanner.scan();

      expect(report.conflicts).toHaveLength(1);
    });
  });

  describe('when a judgement fails', () => {
    // The sweep is long and mostly recoverable; one bad document must not
    // discard the findings already gathered.
    it('continues the sweep and keeps what it already found', async () => {
      const { scanner } = buildScanner({
        chunks: [chunk(1, 'a'), chunk(2, 'b'), chunk(3, 'c')],
        links: { 1: [2], 2: [3], 3: [1] },
        judge: (candidate) =>
          candidate.subject.docId === 'b'
            ? Promise.reject(new Error('429 rate limited'))
            : Promise.resolve([conflictBetween(candidate.subject.docId, 'z')]),
      });

      const report = await scanner.scan();

      expect(report.conflicts).toHaveLength(2);
      expect(report.failures).toBe(1);
    });

    // The distinction `eval:compare` already enforces elsewhere: a partial
    // audit reporting "no conflicts" is an outage dressed as a clean result.
    it('separates documents judged from documents scanned', async () => {
      const { scanner } = buildScanner({
        chunks: [chunk(1, 'a'), chunk(2, 'b')],
        links: { 1: [2], 2: [1] },
        judge: () => Promise.reject(new Error('down')),
      });

      const report = await scanner.scan();

      expect(report.documentsScanned).toBe(2);
      expect(report.documentsJudged).toBe(0);
      expect(report.failures).toBe(2);
    });
  });

  describe('judging several documents at once', () => {
    // The report is diffed between scans, so it cannot depend on which provider
    // happened to answer first — the one way overlapping the work could have
    // silently broken it.
    it('orders findings by document, not by which judgement returned first', async () => {
      const delays: Record<string, number> = { a: 30, b: 0, c: 15 };
      const { scanner } = buildScanner({
        chunks: [chunk(1, 'a'), chunk(2, 'b'), chunk(3, 'c')],
        links: { 1: [2], 2: [3], 3: [1] },
        judge: (candidate) =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve([conflictBetween(candidate.subject.docId, 'z')]),
              delays[candidate.subject.docId],
            ),
          ),
      });

      const report = await scanner.scan({ concurrency: 3 });

      expect(report.conflicts.map((c) => c.outdated.docId)).toEqual(['a', 'b', 'c']);
    });

    it('never runs more judgements at once than it was allowed', async () => {
      let running = 0;
      let peak = 0;
      const { scanner } = buildScanner({
        chunks: [1, 2, 3, 4, 5, 6].map((i) => chunk(i, `d${i}`)),
        links: Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [i, [(i % 6) + 1]])),
        judge: () => {
          running++;
          peak = Math.max(peak, running);
          return new Promise((resolve) =>
            setTimeout(() => {
              running--;
              resolve([]);
            }, 5),
          );
        },
      });

      await scanner.scan({ concurrency: 2 });

      expect(peak).toBe(2);
    });

    it('judges every document exactly once', async () => {
      const { scanner, seen } = buildScanner({
        chunks: [1, 2, 3, 4, 5].map((i) => chunk(i, `d${i}`)),
        links: Object.fromEntries([1, 2, 3, 4, 5].map((i) => [i, [(i % 5) + 1]])),
      });

      await scanner.scan({ concurrency: 3 });

      expect(seen.map((c) => c.subject.docId).sort()).toEqual(['d1', 'd2', 'd3', 'd4', 'd5']);
    });
  });

  it('stops when the caller aborts', async () => {
    const controller = new AbortController();
    const { scanner } = buildScanner({
      chunks: [chunk(1, 'a'), chunk(2, 'b')],
      links: { 1: [2], 2: [1] },
      judge: () => {
        controller.abort();
        return Promise.resolve([]);
      },
    });

    // Single lane so this tests the abort check rather than how two lanes
    // happen to interleave.
    await expect(scanner.scan({ signal: controller.signal, concurrency: 1 })).rejects.toThrow();
  });
});

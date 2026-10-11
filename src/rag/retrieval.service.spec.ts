import type { AppConfigService } from '../config/app-config.service';
import type { Article, Chunk, CorpusSource } from '../common/types/knowledge.types';
import type { EmbeddingProvider } from '../embeddings/embedding.types';
import type { ArticleRepository } from '../repositories/ports/article.repository';
import type { ChunkRepository } from '../repositories/ports/chunk.repository';
import type {
  EmbeddingRepository,
  EmbeddingSearchHit,
} from '../repositories/ports/embedding.repository';
import { RetrievalService } from './retrieval.service';

/**
 * `RetrievalService` is the one path every answer goes through — all four agent
 * tools are this method with a different `sourceFilter` — and it had no unit
 * test. The eval suite covers it end to end, which is a different thing: a suite
 * that needs a corpus, an index and ~350 model calls cannot tell you *why* recall
 * dropped, and it is not run on a pull request.
 *
 * These pin the parts that are joins rather than search: hit → chunk → article,
 * and what happens when one of those lookups comes back empty.
 */

const CHUNKS: Chunk[] = [
  { id: 1, articleId: 10, chunkIndex: 0, text: 'first passage', source: 'mail', docId: 'mail.1' },
  { id: 2, articleId: 10, chunkIndex: 1, text: 'second passage', source: 'mail', docId: 'mail.1' },
  { id: 3, articleId: 20, chunkIndex: 0, text: 'third passage', source: 'chat', docId: 'chat.1' },
];

const ARTICLES: Article[] = [
  { id: 10, title: 'A thread', path: 'mail/a.md', checksum: 'x', updatedAt: '2026-01-01' },
  { id: 20, title: 'A channel', path: 'chat/b.md', checksum: 'y', updatedAt: '2026-01-01' },
];

interface Harness {
  service: RetrievalService;
  embedded: { texts: string[]; signal?: AbortSignal }[];
  searched: { topK: number; sourceFilter?: CorpusSource[] }[];
  /** Article ids `findById` was called with, in order — one entry per call. */
  lookups: number[];
}

function build(
  options: { hits?: EmbeddingSearchHit[]; chunks?: Chunk[]; articles?: Article[] } = {},
): Harness {
  const embedded: Harness['embedded'] = [];
  const searched: Harness['searched'] = [];

  const embeddings: EmbeddingProvider = {
    modelId: 'stub/model',
    dimensions: 3,
    embed: (texts: string[], signal?: AbortSignal) => {
      embedded.push({ texts, signal });
      return Promise.resolve(texts.map(() => [0.1, 0.2, 0.3]));
    },
  };

  const embeddingRepository: EmbeddingRepository = {
    insertMany: () => Promise.resolve(),
    deleteByChunkIds: () => Promise.resolve(),
    search: (_v, topK, sourceFilter) => {
      searched.push({ topK, sourceFilter });
      return Promise.resolve(options.hits ?? [{ chunkId: 1, distance: 0.4 }]);
    },
    // Retrieval never walks the index from a chunk; only the conflict scanner does.
    neighbours: () => Promise.resolve([]),
  };

  const available = options.chunks ?? CHUNKS;
  const chunkRepository = {
    findByIds: (ids: number[]) => Promise.resolve(available.filter((c) => ids.includes(c.id))),
  } as unknown as ChunkRepository;

  const articles = options.articles ?? ARTICLES;
  const lookups: number[] = [];
  const articleRepository = {
    findById: (id: number) => {
      lookups.push(id);
      return Promise.resolve(articles.find((a) => a.id === id) ?? null);
    },
  } as unknown as ArticleRepository;

  const service = new RetrievalService(
    { topK: 5 } as unknown as AppConfigService,
    embeddings,
    articleRepository,
    chunkRepository,
    embeddingRepository,
  );

  return { service, embedded, searched, lookups };
}

describe('RetrievalService.search', () => {
  it('joins a vector hit to its chunk text and its article title', () => {
    const { service } = build({ hits: [{ chunkId: 3, distance: 0.42 }] });

    return service.search('who said what').then((results) => {
      expect(results).toEqual([
        {
          chunkId: 3,
          articleId: 20,
          articleTitle: 'A channel',
          text: 'third passage',
          distance: 0.42,
          source: 'chat',
          docId: 'chat.1',
        },
      ]);
    });
  });

  it('preserves the ranking the vector index returned', async () => {
    // The order is the retrieval result. `findByIds` is a set lookup and makes no
    // promise about order, so re-sorting by it would silently rank by rowid —
    // and `synthesize` truncates by position before numbering citations.
    const { service } = build({
      hits: [
        { chunkId: 3, distance: 0.2 },
        { chunkId: 1, distance: 0.5 },
        { chunkId: 2, distance: 0.9 },
      ],
    });

    const results = await service.search('q');

    expect(results.map((r) => r.chunkId)).toEqual([3, 1, 2]);
    expect(results.map((r) => r.distance)).toEqual([0.2, 0.5, 0.9]);
  });

  it('drops a hit whose chunk has gone rather than emitting a hole', async () => {
    // `vec_chunks` has no foreign key to `chunks`, so a delete that missed the
    // vector table leaves a hit pointing at nothing. Returning it with empty
    // text would put a blank passage in front of the model and mint an
    // evidenceId the answer could cite.
    const { service } = build({
      hits: [
        { chunkId: 1, distance: 0.3 },
        { chunkId: 999, distance: 0.35 },
      ],
    });

    const results = await service.search('q');

    expect(results.map((r) => r.chunkId)).toEqual([1]);
  });

  it('keeps a chunk whose article row is missing, labelled rather than dropped', async () => {
    // The passage is still real evidence — only its title is unknown. Dropping it
    // would lose retrievable text over a display field.
    const { service } = build({
      hits: [{ chunkId: 1, distance: 0.3 }],
      articles: [],
    });

    const [result] = await service.search('q');

    expect(result.text).toBe('first passage');
    expect(result.articleTitle).toBe('Unknown');
  });

  it('looks each article up once even when several chunks share it', async () => {
    // Chunks 1 and 2 both belong to article 10. A lookup per hit would be N+1
    // against the database on every search the agent makes.
    const { service, lookups } = build({
      hits: [
        { chunkId: 1, distance: 0.3 },
        { chunkId: 2, distance: 0.4 },
      ],
    });

    const results = await service.search('q');

    expect(results).toHaveLength(2);
    expect(lookups).toEqual([10]);
  });

  it('passes the source filter through untouched', async () => {
    // This is the whole difference between mail_search and chat_search.
    const { service, searched } = build();

    await service.search('q', undefined, ['mail', 'notes']);

    expect(searched[0].sourceFilter).toEqual(['mail', 'notes']);
  });

  it('falls back to the configured topK when the caller does not specify one', async () => {
    const { service, searched } = build();

    await service.search('q');
    await service.search('q', 2);

    expect(searched.map((s) => s.topK)).toEqual([5, 2]);
  });

  it('forwards the abort signal to the embedding call, the only network hop', async () => {
    const controller = new AbortController();
    const { service, embedded } = build();

    await service.search('q', undefined, undefined, controller.signal);

    expect(embedded[0].signal).toBe(controller.signal);
  });

  it('returns nothing when the index has no hits, without touching the chunk store', async () => {
    const { service } = build({ hits: [] });

    expect(await service.search('q')).toEqual([]);
  });
});

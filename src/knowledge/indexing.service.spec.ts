import type { AppConfigService } from '../config/app-config.service';
import type { Article, Chunk, IndexState } from '../common/types/knowledge.types';
import type { EmbeddingProvider } from '../embeddings/embedding.types';
import type { ArticleRepository } from '../repositories/ports/article.repository';
import type { ChunkRepository, NewChunk } from '../repositories/ports/chunk.repository';
import type { EmbeddingRepository } from '../repositories/ports/embedding.repository';
import type { IndexStateRepository } from '../repositories/ports/index-state.repository';
import { IndexingService } from './indexing.service';
import * as loader from './markdown-loader';
import type { LoadedArticle } from './markdown-loader';

/**
 * Indexing is the expensive operation in the system — one embedding call per
 * document, against a free tier that answers ~20 per window — so the behaviours
 * worth pinning are the ones that decide whether a call is made at all, and the
 * one that decides whether an index is destroyed.
 *
 * `loadMarkdownArticles` is stubbed rather than given real files: the loader has
 * its own spec, and what matters here is what the service does with what it gets.
 */

function doc(path: string, content = 'body text', checksum = 'sum-1'): LoadedArticle {
  return { path, title: path, content, checksum, source: 'mail', docId: `doc.${path}` };
}

interface Harness {
  service: IndexingService;
  embedCalls: string[][];
  state: Map<string, IndexState>;
  deletedArticleIds: number[];
  deletedChunkIds: number[];
  insertedChunks: NewChunk[];
  meta: Map<string, string>;
}

function build(options: { indexed?: IndexState[]; articles?: Article[] } = {}): Harness {
  const embedCalls: string[][] = [];
  const state = new Map((options.indexed ?? []).map((s) => [s.path, s]));
  const deletedArticleIds: number[] = [];
  const deletedChunkIds: number[] = [];
  const insertedChunks: NewChunk[] = [];
  const meta = new Map<string, string>();

  const articles = new Map((options.articles ?? []).map((a) => [a.path, a]));
  let nextArticleId = 100;
  let nextChunkId = 1000;
  const chunksByArticle = new Map<number, Chunk[]>();

  const embeddings: EmbeddingProvider = {
    modelId: 'gemini/gemini-embedding-001',
    dimensions: 768,
    embed: (texts: string[]) => {
      embedCalls.push(texts);
      return Promise.resolve(texts.map(() => [0.1, 0.2, 0.3]));
    },
  };

  const articleRepository: ArticleRepository = {
    findByPath: (path: string) => Promise.resolve(articles.get(path) ?? null),
    findById: (id: number) =>
      Promise.resolve([...articles.values()].find((a) => a.id === id) ?? null),
    upsert: (input) => {
      const existing = articles.get(input.path);
      const article: Article = existing
        ? { ...existing, ...input, updatedAt: '2026-01-01' }
        : { id: nextArticleId++, ...input, updatedAt: '2026-01-01' };
      articles.set(article.path, article);
      return Promise.resolve(article);
    },
    deleteById: (id: number) => {
      deletedArticleIds.push(id);
      for (const [path, a] of articles) if (a.id === id) articles.delete(path);
      return Promise.resolve();
    },
  };

  const chunkRepository = {
    insertMany: (articleId: number, rows: NewChunk[]) => {
      insertedChunks.push(...rows);
      const created = rows.map((r) => ({ id: nextChunkId++, articleId, ...r }));
      chunksByArticle.set(articleId, created);
      return Promise.resolve(created);
    },
    findByArticleId: (articleId: number) => Promise.resolve(chunksByArticle.get(articleId) ?? []),
    deleteByArticleId: (articleId: number) => {
      chunksByArticle.delete(articleId);
      return Promise.resolve();
    },
  } as unknown as ChunkRepository;

  const embeddingRepository: EmbeddingRepository = {
    insertMany: () => Promise.resolve(),
    deleteByChunkIds: (ids: number[]) => {
      deletedChunkIds.push(...ids);
      return Promise.resolve();
    },
    search: () => Promise.resolve([]),
    // Indexing writes vectors; only the conflict scanner reads them back out.
    neighbours: () => Promise.resolve([]),
  };

  const indexStateRepository: IndexStateRepository = {
    get: (path: string) => Promise.resolve(state.get(path) ?? null),
    upsert: (s: IndexState) => {
      state.set(s.path, s);
      return Promise.resolve();
    },
    all: () => Promise.resolve([...state.values()]),
    delete: (path: string) => {
      state.delete(path);
      return Promise.resolve();
    },
    setMeta: (key: string, value: string) => {
      meta.set(key, value);
      return Promise.resolve();
    },
    getMeta: (key: string) => Promise.resolve(meta.get(key) ?? null),
  };

  const service = new IndexingService(
    { knowledgePath: './corpus/generated', chunkSize: 700, chunkOverlap: 100 } as AppConfigService,
    embeddings,
    articleRepository,
    chunkRepository,
    embeddingRepository,
    indexStateRepository,
  );

  return { service, embedCalls, state, deletedArticleIds, deletedChunkIds, insertedChunks, meta };
}

function onDisk(articles: LoadedArticle[]): void {
  jest.spyOn(loader, 'loadMarkdownArticles').mockReturnValue(articles);
}

afterEach(() => jest.restoreAllMocks());

describe('IndexingService.reindexAll', () => {
  it('indexes a document that has never been seen', async () => {
    onDisk([doc('mail/a.md')]);
    const { service, embedCalls } = build();

    const summary = await service.reindexAll();

    expect(summary.indexed).toEqual(['mail/a.md']);
    expect(summary.skipped).toEqual([]);
    expect(embedCalls).toHaveLength(1);
  });

  it('skips a document whose checksum is unchanged, making no embedding call', async () => {
    // This is what makes a container boot free: 172 documents, 0 calls. The
    // Docker job asserts `indexed=0 skipped=172` for exactly this reason.
    onDisk([doc('mail/a.md', 'body', 'sum-1')]);
    const { service, embedCalls } = build({
      indexed: [{ path: 'mail/a.md', lastIndexed: '2026-01-01', checksum: 'sum-1' }],
    });

    const summary = await service.reindexAll();

    expect(summary.skipped).toEqual(['mail/a.md']);
    expect(summary.indexed).toEqual([]);
    expect(embedCalls).toEqual([]);
  });

  it('re-indexes when the checksum changed, clearing the old vectors first', async () => {
    // Orphaned vectors in `vec_chunks` outlive their chunks — there is no foreign
    // key — so a stale embedding stays searchable and returns a hit that
    // `RetrievalService` then drops, quietly shrinking every result set.
    onDisk([doc('mail/a.md', 'new body', 'sum-2')]);
    const { service, embedCalls } = build({
      indexed: [{ path: 'mail/a.md', lastIndexed: '2026-01-01', checksum: 'sum-1' }],
      articles: [
        { id: 10, title: 'a', path: 'mail/a.md', checksum: 'sum-1', updatedAt: '2026-01-01' },
      ],
    });

    const summary = await service.reindexAll();

    expect(summary.indexed).toEqual(['mail/a.md']);
    expect(embedCalls).toHaveLength(1);
  });

  it('carries the source and docId from the loader through to the chunk rows', async () => {
    // `source` drives every per-source tool and `docId` is what the eval suite
    // scores `expectedDocIds` against; losing either here is invisible until a
    // metric moves.
    onDisk([doc('mail/a.md')]);
    const { service, insertedChunks } = build();

    await service.reindexAll();

    expect(insertedChunks[0].source).toBe('mail');
    expect(insertedChunks[0].docId).toBe('doc.mail/a.md');
  });

  it('removes a document that has disappeared from disk', async () => {
    onDisk([doc('mail/a.md')]);
    const { service, deletedArticleIds } = build({
      indexed: [
        { path: 'mail/a.md', lastIndexed: '2026-01-01', checksum: 'sum-1' },
        { path: 'mail/gone.md', lastIndexed: '2026-01-01', checksum: 'sum-9' },
      ],
      articles: [
        { id: 10, title: 'a', path: 'mail/a.md', checksum: 'sum-1', updatedAt: '2026-01-01' },
        { id: 99, title: 'gone', path: 'mail/gone.md', checksum: 'sum-9', updatedAt: '2026-01-01' },
      ],
    });

    const summary = await service.reindexAll();

    expect(summary.removed).toEqual(['mail/gone.md']);
    expect(deletedArticleIds).toEqual([99]);
  });

  it('records the embedding identity from the provider, not from config', async () => {
    // `precomputed` replays vectors another model produced and reports *that*
    // model's identity. Deriving it from EMBEDDING_PROVIDER would stamp a
    // keyless build as `precomputed/...` and then refuse to boot against it.
    onDisk([doc('mail/a.md')]);
    const { service, meta } = build();

    await service.reindexAll();

    expect(meta.get('embedding_identity')).toBe('gemini/gemini-embedding-001:768');
  });

  it('shares one in-flight pass between concurrent callers', async () => {
    // The boot scheduler and `POST /knowledge/reindex` can land together, and two
    // interleaved passes would delete and reinsert the same chunks with no
    // database-level lock to stop them.
    onDisk([doc('mail/a.md')]);
    const { service, embedCalls } = build();

    const [first, second] = await Promise.all([service.reindexAll(), service.reindexAll()]);

    expect(embedCalls).toHaveLength(1);
    expect(first).toBe(second);
  });

  it('starts a fresh pass once the previous one has settled', async () => {
    onDisk([doc('mail/a.md')]);
    const { service, embedCalls } = build();

    await service.reindexAll();
    onDisk([doc('mail/a.md', 'changed', 'sum-2')]);
    await service.reindexAll();

    expect(embedCalls).toHaveLength(2);
  });
});

/**
 * The §9 near-miss, as a test.
 *
 * `removeDeletedArticles` derives "deleted" from absence, so an empty load reads
 * as every document having been removed at once. Without `COPY corpus` in the
 * runtime image, the boot reindex would have deleted the baked index the image
 * exists to ship — a healthy startup destroying the deployment, with `removed=172`
 * the only trace. The image copies the corpus now; this is the half that survives
 * the same mistake arriving by a different route (a bad `KNOWLEDGE_PATH`, a
 * volume mounted over the directory).
 */
describe('IndexingService — the empty-corpus guard', () => {
  it('refuses to reindex when the corpus is empty but the index is not', async () => {
    onDisk([]);
    const { service, deletedArticleIds } = build({
      indexed: [
        { path: 'mail/a.md', lastIndexed: '2026-01-01', checksum: 'sum-1' },
        { path: 'chat/b.md', lastIndexed: '2026-01-01', checksum: 'sum-2' },
      ],
    });

    await expect(service.reindexAll()).rejects.toThrow(/Refusing to reindex/);
    expect(deletedArticleIds).toEqual([]);
  });

  it('names the path and the number of documents at risk', async () => {
    // The message is the whole value of the guard: it has to say what to check.
    onDisk([]);
    const { service } = build({
      indexed: [{ path: 'mail/a.md', lastIndexed: '2026-01-01', checksum: 'sum-1' }],
    });

    await expect(service.reindexAll()).rejects.toThrow(/corpus\/generated/);
    await expect(service.reindexAll()).rejects.toThrow(/KNOWLEDGE_PATH/);
  });

  it('allows an empty corpus when the index is empty too', async () => {
    // A fresh install has nothing to lose, and refusing here would make a new
    // checkout fail to boot.
    onDisk([]);
    const { service } = build();

    await expect(service.reindexAll()).resolves.toEqual({
      indexed: [],
      skipped: [],
      removed: [],
      totalChunks: 0,
    });
  });

  it('leaves the ordinary one-document deletion alone', async () => {
    // The guard must not turn every removal into an error — only the case where
    // *everything* vanished at once.
    onDisk([doc('mail/a.md')]);
    const { service } = build({
      indexed: [
        { path: 'mail/a.md', lastIndexed: '2026-01-01', checksum: 'sum-1' },
        { path: 'mail/gone.md', lastIndexed: '2026-01-01', checksum: 'sum-9' },
      ],
    });

    const summary = await service.reindexAll();

    expect(summary.removed).toEqual(['mail/gone.md']);
  });
});

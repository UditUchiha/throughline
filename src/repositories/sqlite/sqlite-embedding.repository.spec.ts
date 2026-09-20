import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from '../../database/migrations';
import { SqliteArticleRepository } from './sqlite-article.repository';
import { SqliteChunkRepository } from './sqlite-chunk.repository';
import { SqliteEmbeddingRepository } from './sqlite-embedding.repository';
import type { CorpusSource } from '../../common/types/knowledge.types';

const DIMS = 8;

/**
 * `search` with a `sourceFilter` is the most intricate code in the project and
 * had no test. sqlite-vec's `vec0` table supports neither a JOIN nor a WHERE on a
 * non-vector column, so a filtered search over-fetches by distance and
 * post-filters — and a *fixed* over-fetch silently under-returns whenever the
 * requested source is sparse among the nearest neighbours. The loop widens `k`
 * until it either satisfies `topK` or provably exhausts the index.
 *
 * That is exactly the kind of logic that looks right and returns three results
 * where five exist: `mail_search` would quietly answer from less evidence than
 * the corpus holds, and `recallAtK` would drop with nothing to point at. These
 * pin the widening, the exhaustion, and the ordering.
 *
 * Eight dimensions rather than the real 768 — the subject is the search
 * strategy, and hand-written vectors are only readable small.
 */
function db(): Database.Database {
  const database = new Database(':memory:');
  sqliteVec.load(database);
  runMigrations(database, DIMS);
  return database;
}

/** A vector at `angle` in the first two dimensions, so distances are orderable. */
function vec(offset: number): number[] {
  return Array.from({ length: DIMS }, (_, i) => (i === 0 ? 1 : i === 1 ? offset : 0));
}

describe('SqliteEmbeddingRepository.search', () => {
  let database: Database.Database;
  let embeddings: SqliteEmbeddingRepository;
  let chunks: SqliteChunkRepository;
  let articles: SqliteArticleRepository;

  beforeEach(() => {
    database = db();
    embeddings = new SqliteEmbeddingRepository(database);
    chunks = new SqliteChunkRepository(database);
    articles = new SqliteArticleRepository(database);
  });

  afterEach(() => database.close());

  /**
   * Seeds one chunk per entry, with the vector `vec(i)` — so entry 0 is nearest
   * to `vec(0)`, entry 1 next, and so on. The `sources` array decides which
   * source each chunk carries, which is what the filter selects on.
   */
  async function seed(sources: (CorpusSource | null)[]): Promise<void> {
    const article = await articles.upsert({ title: 'a', path: 'a.md', checksum: 'x' });
    const rows = await chunks.insertMany(
      article.id,
      sources.map((source, i) => ({
        chunkIndex: i,
        text: `chunk ${i} (${source ?? 'none'})`,
        source,
        docId: `doc.${i}`,
      })),
    );
    await embeddings.insertMany(
      rows.map((row, i) => ({ chunkId: row.id, embedding: vec(i * 0.1) })),
    );
  }

  it('returns the nearest chunks, closest first, when unfiltered', async () => {
    await seed(['mail', 'chat', 'notes']);

    const hits = await embeddings.search(vec(0), 3);

    expect(hits).toHaveLength(3);
    expect(hits[0].distance).toBeLessThanOrEqual(hits[1].distance);
    expect(hits[1].distance).toBeLessThanOrEqual(hits[2].distance);
  });

  it('honours topK', async () => {
    await seed(['mail', 'mail', 'mail', 'mail']);

    expect(await embeddings.search(vec(0), 2)).toHaveLength(2);
  });

  it('returns only chunks of the requested source', async () => {
    await seed(['mail', 'chat', 'notes']);

    const hits = await embeddings.search(vec(0), 5, ['chat']);
    const ids = hits.map((h) => h.chunkId);
    const rows = await chunks.findByIds(ids);

    expect(rows.every((row) => row.source === 'chat')).toBe(true);
  });

  it('accepts several sources at once, as all_sources_search does not but chat+notes could', async () => {
    await seed(['mail', 'chat', 'notes', 'mail']);

    const hits = await embeddings.search(vec(0), 10, ['chat', 'notes']);
    const rows = await chunks.findByIds(hits.map((h) => h.chunkId));

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.source).sort()).toEqual(['chat', 'notes']);
  });

  it('widens the window rather than under-returning when the source is sparse', async () => {
    // The failure this loop exists to prevent. The four nearest chunks are all
    // `chat`; the two `mail` ones are the *farthest*. A fixed over-fetch of
    // `topK * 4` would look at the nearest 8 — which here is everything, so make
    // the point sharper: 20 chat chunks in front of 2 mail ones. Asking
    // mail_search for 2 must return 2, not 0.
    await seed([...Array<CorpusSource>(20).fill('chat'), 'mail', 'mail']);

    const hits = await embeddings.search(vec(0), 2, ['mail']);
    const rows = await chunks.findByIds(hits.map((h) => h.chunkId));

    expect(hits).toHaveLength(2);
    expect(rows.every((row) => row.source === 'mail')).toBe(true);
  });

  it('returns everything available when the corpus holds fewer than topK of that source', async () => {
    // A short result set here is the real answer, not an artifact of the window,
    // and the loop has to be able to tell the difference — otherwise it widens
    // forever.
    await seed([...Array<CorpusSource>(10).fill('chat'), 'mail']);

    const hits = await embeddings.search(vec(0), 5, ['mail']);

    expect(hits).toHaveLength(1);
  });

  it('returns nothing for a source with no chunks at all, without scanning', async () => {
    await seed(['mail', 'mail']);

    expect(await embeddings.search(vec(0), 5, ['notes'])).toEqual([]);
  });

  it('treats an empty filter as unfiltered', async () => {
    await seed(['mail', 'chat']);

    expect(await embeddings.search(vec(0), 5, [])).toHaveLength(2);
  });

  it('never returns a chunk whose source is null under a filter', async () => {
    // A document with no frontmatter and no recognisable directory. It is
    // retrievable by `all_sources_search` and must not leak into a targeted one.
    await seed([null, 'mail']);

    const hits = await embeddings.search(vec(0), 5, ['mail']);
    const rows = await chunks.findByIds(hits.map((h) => h.chunkId));

    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('mail');
  });

  it('drops vectors when their chunks are deleted', async () => {
    await seed(['mail', 'chat']);
    const before = await embeddings.search(vec(0), 5);

    await embeddings.deleteByChunkIds([Number(before[0].chunkId)]);

    expect(await embeddings.search(vec(0), 5)).toHaveLength(1);
  });

  it('ignores an empty delete rather than clearing the table', async () => {
    await seed(['mail', 'chat']);

    await embeddings.deleteByChunkIds([]);

    expect(await embeddings.search(vec(0), 5)).toHaveLength(2);
  });
});

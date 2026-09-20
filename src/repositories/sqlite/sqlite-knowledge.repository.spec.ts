import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from '../../database/migrations';
import { SqliteArticleRepository } from './sqlite-article.repository';
import { SqliteChunkRepository } from './sqlite-chunk.repository';
import { SqliteIndexStateRepository } from './sqlite-index-state.repository';

/**
 * The three adapters `IndexingService` writes through, none of which had a test.
 *
 * What is worth pinning here is not the SQL — it is the bookkeeping the indexer
 * depends on and would not notice breaking: that a re-upsert keeps an article's
 * identity (so its chunks are not orphaned), that deleting an article cascades to
 * its chunks (the migration's `ON DELETE CASCADE`, which nothing asserts
 * otherwise), and that a `source` column holding something unexpected is read as
 * absent rather than cast into the type system.
 */
function db(): Database.Database {
  const database = new Database(':memory:');
  sqliteVec.load(database);
  runMigrations(database, 8);
  return database;
}

describe('SqliteArticleRepository', () => {
  let database: Database.Database;
  let articles: SqliteArticleRepository;

  beforeEach(() => {
    database = db();
    articles = new SqliteArticleRepository(database);
  });
  afterEach(() => database.close());

  it('inserts an article and finds it by path and by id', async () => {
    const created = await articles.upsert({ title: 'A thread', path: 'mail/a.md', checksum: 'c1' });

    expect(await articles.findByPath('mail/a.md')).toEqual(created);
    expect(await articles.findById(created.id)).toEqual(created);
  });

  it('keeps the same id when an article is re-upserted', async () => {
    // The indexer deletes an article's chunks by id before reinserting. A new id
    // on re-upsert would leave the old chunks parented to a row nothing points
    // at — they would stay searchable and serve text from the previous version.
    const first = await articles.upsert({ title: 'v1', path: 'mail/a.md', checksum: 'c1' });
    const second = await articles.upsert({ title: 'v2', path: 'mail/a.md', checksum: 'c2' });

    expect(second.id).toBe(first.id);
    expect(second.title).toBe('v2');
    expect(second.checksum).toBe('c2');
  });

  it('returns null for a path or id it does not have', async () => {
    expect(await articles.findByPath('nope.md')).toBeNull();
    expect(await articles.findById(9999)).toBeNull();
  });
});

describe('SqliteChunkRepository', () => {
  let database: Database.Database;
  let articles: SqliteArticleRepository;
  let chunks: SqliteChunkRepository;

  beforeEach(() => {
    database = db();
    articles = new SqliteArticleRepository(database);
    chunks = new SqliteChunkRepository(database);
  });
  afterEach(() => database.close());

  async function article() {
    return articles.upsert({ title: 'a', path: 'mail/a.md', checksum: 'c1' });
  }

  it('round-trips source and docId', async () => {
    const { id } = await article();

    const [chunk] = await chunks.insertMany(id, [
      { chunkIndex: 0, text: 'body', source: 'mail', docId: 'mail.thread-1' },
    ]);

    expect(chunk.source).toBe('mail');
    expect(chunk.docId).toBe('mail.thread-1');
    expect((await chunks.findById(chunk.id))?.source).toBe('mail');
  });

  it('reads an unrecognised source column as absent rather than casting it', async () => {
    // `chunks.source` is TEXT with no CHECK constraint, so an older schema, a
    // hand-edited row or a newer generator can put anything there. The adapter
    // used to hand it on as a `CorpusSource`, which then indexed `SOURCE_STYLES`
    // in the UI. Written through raw SQL because the port's type no longer
    // permits expressing it — which is the point.
    const { id } = await article();
    const [chunk] = await chunks.insertMany(id, [
      { chunkIndex: 0, text: 'body', source: 'mail', docId: null },
    ]);
    database.prepare('UPDATE chunks SET source = ? WHERE id = ?').run('slack', chunk.id);

    expect((await chunks.findById(chunk.id))?.source).toBeNull();
  });

  it('preserves insertion order and index', async () => {
    const { id } = await article();

    const inserted = await chunks.insertMany(id, [
      { chunkIndex: 0, text: 'first', source: 'mail', docId: null },
      { chunkIndex: 1, text: 'second', source: 'mail', docId: null },
    ]);

    expect(inserted.map((c) => c.text)).toEqual(['first', 'second']);
    expect(inserted.map((c) => c.chunkIndex)).toEqual([0, 1]);
  });

  it('finds many by id, skipping ones that are gone', async () => {
    const { id } = await article();
    const [chunk] = await chunks.insertMany(id, [
      { chunkIndex: 0, text: 'body', source: 'chat', docId: null },
    ]);

    const found = await chunks.findByIds([chunk.id, 9999]);

    expect(found).toHaveLength(1);
  });

  it('returns nothing for an empty id list rather than every chunk', async () => {
    const { id } = await article();
    await chunks.insertMany(id, [{ chunkIndex: 0, text: 'body', source: 'chat', docId: null }]);

    expect(await chunks.findByIds([])).toEqual([]);
  });

  it('deletes an article cascade to its chunks', async () => {
    // The migration declares ON DELETE CASCADE and `removeDeletedArticles`
    // relies on it — it deletes the article and never touches `chunks`.
    const created = await article();
    await chunks.insertMany(created.id, [
      { chunkIndex: 0, text: 'body', source: 'mail', docId: null },
    ]);

    await articles.deleteById(created.id);

    expect(await chunks.findByArticleId(created.id)).toEqual([]);
  });

  it('deletes an article’s chunks without deleting the article', async () => {
    // The re-index path: chunks go, the article row stays and is upserted.
    const created = await article();
    await chunks.insertMany(created.id, [
      { chunkIndex: 0, text: 'body', source: 'mail', docId: null },
    ]);

    await chunks.deleteByArticleId(created.id);

    expect(await chunks.findByArticleId(created.id)).toEqual([]);
    expect(await articles.findById(created.id)).not.toBeNull();
  });
});

describe('SqliteIndexStateRepository', () => {
  let database: Database.Database;
  let state: SqliteIndexStateRepository;

  beforeEach(() => {
    database = db();
    state = new SqliteIndexStateRepository(database);
  });
  afterEach(() => database.close());

  const entry = (path: string, checksum: string) => ({
    path,
    lastIndexed: '2026-01-01T00:00:00.000Z',
    checksum,
  });

  it('stores and reads back a checksum, which is what makes a reindex free', async () => {
    await state.upsert(entry('mail/a.md', 'c1'));

    expect((await state.get('mail/a.md'))?.checksum).toBe('c1');
  });

  it('overwrites on re-upsert rather than accumulating rows', async () => {
    await state.upsert(entry('mail/a.md', 'c1'));
    await state.upsert(entry('mail/a.md', 'c2'));

    expect((await state.get('mail/a.md'))?.checksum).toBe('c2');
    expect(await state.all()).toHaveLength(1);
  });

  it('lists everything indexed, which is what the empty-corpus guard counts', async () => {
    await state.upsert(entry('mail/a.md', 'c1'));
    await state.upsert(entry('chat/b.md', 'c2'));

    expect((await state.all()).map((s) => s.path).sort()).toEqual(['chat/b.md', 'mail/a.md']);
  });

  it('deletes one path', async () => {
    await state.upsert(entry('mail/a.md', 'c1'));

    await state.delete('mail/a.md');

    expect(await state.get('mail/a.md')).toBeNull();
  });

  it('round-trips the embedding identity meta value', async () => {
    // The boot guard compares against this exact string; a null read is what
    // makes a brand-new database boot instead of refusing.
    expect(await state.getMeta('embedding_identity')).toBeNull();

    await state.setMeta('embedding_identity', 'gemini/gemini-embedding-001:768');

    expect(await state.getMeta('embedding_identity')).toBe('gemini/gemini-embedding-001:768');
  });

  it('overwrites a meta value rather than failing on the second write', async () => {
    await state.setMeta('embedding_identity', 'a:1');
    await state.setMeta('embedding_identity', 'b:2');

    expect(await state.getMeta('embedding_identity')).toBe('b:2');
  });
});

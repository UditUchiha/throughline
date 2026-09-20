import { Logger } from '@nestjs/common';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { checkIndexIdentity } from './database.module';
import { runMigrations } from './migrations';
import { embeddingIdentity, embeddingModelId } from '../embeddings/embedding.types';

/**
 * The boot guard that refuses to serve retrieval from vectors a different model
 * produced. It has been wrong twice, both times as a boot failure:
 *
 *   1. **M1.2** — the writer stored `gemini/gemini-embedding-001:768` while the
 *      check looked for `gemini-embedding-001:768`, so it rejected an index it had
 *      just built correctly. Both sides go through `embeddingIdentity()` now.
 *   2. **§9** — the check read the identity off `AppConfigService` while
 *      `IndexingService` wrote it off the live provider. Equivalent for gemini and
 *      ollama, wrong for `precomputed`, which reports the identity of the model
 *      whose vectors it replays — so a keyless Docker build stamped
 *      `precomputed/...` and then refused to boot against its own index.
 *
 * Getting this wrong in the *other* direction is worse than a failed boot: a
 * guard that passes a genuine mismatch serves nearest-neighbour results computed
 * in the wrong vector space, which looks like poor retrieval quality rather than
 * a misconfiguration.
 */
function db(): Database.Database {
  const database = new Database(':memory:');
  sqliteVec.load(database);
  runMigrations(database, 8);
  return database;
}

const IDENTITY = embeddingIdentity(embeddingModelId('gemini', 'gemini-embedding-001'), 768);

describe('checkIndexIdentity', () => {
  let database: Database.Database;
  const logger = new Logger('test');

  beforeEach(() => {
    database = db();
  });
  afterEach(() => database.close());

  function record(identity: string): void {
    database
      .prepare(`INSERT INTO index_meta (key, value) VALUES ('embedding_identity', ?)`)
      .run(identity);
  }

  it('passes on a fresh database, where no index exists to mismatch', () => {
    // A new checkout must boot. The identity is written by the first reindex, so
    // there is nothing to compare against until then.
    expect(() => checkIndexIdentity(database, IDENTITY, logger)).not.toThrow();
  });

  it('passes when the stored identity matches', () => {
    record(IDENTITY);

    expect(() => checkIndexIdentity(database, IDENTITY, logger)).not.toThrow();
  });

  it('passes for an identity built the way IndexingService builds it', () => {
    // The M1.2 regression, stated as the property that failed: the string the
    // writer produces and the string the checker looks for must be the same
    // string. Both sides go through `embeddingIdentity` for exactly this.
    const written = embeddingIdentity(embeddingModelId('gemini', 'gemini-embedding-001'), 768);
    record(written);

    expect(() => checkIndexIdentity(database, IDENTITY, logger)).not.toThrow();
  });

  it('refuses when the model changed', () => {
    record(embeddingIdentity(embeddingModelId('ollama', 'bge-m3'), 768));

    expect(() => checkIndexIdentity(database, IDENTITY, logger)).toThrow(
      /Embedding model mismatch/,
    );
  });

  it('refuses when only the dimensions changed', () => {
    // Same model name, different width: every stored vector is the wrong length
    // and sqlite-vec would reject or mis-compare them.
    record(embeddingIdentity(embeddingModelId('gemini', 'gemini-embedding-001'), 1536));

    expect(() => checkIndexIdentity(database, IDENTITY, logger)).toThrow(
      /Embedding model mismatch/,
    );
  });

  it('refuses when the same model name is served by a different provider', () => {
    record(embeddingIdentity(embeddingModelId('ollama', 'gemini-embedding-001'), 768));

    expect(() => checkIndexIdentity(database, IDENTITY, logger)).toThrow(
      /Embedding model mismatch/,
    );
  });

  it('names both identities and what to do about it', () => {
    // The message is the whole value at 3am: which index, which config, and the
    // two ways out.
    record(embeddingIdentity(embeddingModelId('ollama', 'bge-m3'), 1024));

    expect(() => checkIndexIdentity(database, IDENTITY, logger)).toThrow(
      /ollama\/bge-m3:1024[\s\S]*gemini\/gemini-embedding-001:768/,
    );
    expect(() => checkIndexIdentity(database, IDENTITY, logger)).toThrow(/reindex/);
  });

  it('accepts a precomputed build, which reports the replayed model not the provider', () => {
    // The §9 regression. `EMBEDDING_PROVIDER=precomputed` builds the index in
    // Docker, and the artifact carries `gemini/gemini-embedding-001` — so the
    // identity written is the *replayed* model's. A server later booting with the
    // real gemini provider must accept that index, because the vectors in it are
    // genuinely gemini's.
    record(IDENTITY);

    expect(() => checkIndexIdentity(database, IDENTITY, logger)).not.toThrow();
  });
});

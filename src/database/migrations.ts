import Database from 'better-sqlite3';

export function runMigrations(db: Database.Database, embeddingDimensions: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      source TEXT,
      doc_id TEXT
    );

    CREATE TABLE IF NOT EXISTS index_state (
      path TEXT PRIMARY KEY,
      last_indexed TEXT NOT NULL,
      checksum TEXT NOT NULL
    );
  `);

  // `CREATE TABLE IF NOT EXISTS` above is a no-op on a database created before
  // source/doc_id existed — the table is already there, so the new columns would
  // never appear and every query touching them would fail with "no such column".
  // SQLite has no `ADD COLUMN IF NOT EXISTS`, so check the live schema and patch.
  addMissingChunkColumns(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chunks_article_id ON chunks(article_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding FLOAT[${embeddingDimensions}]
    );
  `);
}

/**
 * Bring a pre-existing `chunks` table up to the current schema. Both columns are
 * nullable with no default, so backfilling is unnecessary: rows indexed before this
 * migration simply carry NULL until the next reindex rewrites them (which happens
 * automatically, since a reindex deletes and re-inserts an article's chunks).
 */
function addMissingChunkColumns(db: Database.Database): void {
  const existing = new Set(
    db.prepare<[], { name: string }>(`PRAGMA table_info(chunks)`).all().map((c) => c.name),
  );

  if (!existing.has('source')) db.exec(`ALTER TABLE chunks ADD COLUMN source TEXT`);
  if (!existing.has('doc_id')) db.exec(`ALTER TABLE chunks ADD COLUMN doc_id TEXT`);
}

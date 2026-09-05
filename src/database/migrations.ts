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
    CREATE TABLE IF NOT EXISTS index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // --- Trace store (PLAN.md §5/M3.2) ---
  //
  // Runs and their spans, replacing the in-memory store M1 used to back
  // `GET /agent/runs/:runId`. Payloads that are only ever read back whole — the
  // event stream, the answer, the model list — are stored as JSON text rather than
  // shredded into columns: nothing queries inside them, and a schema for them would
  // have to be kept in step with a frozen event contract for no gain.
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      question TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('finished', 'failed')),
      answer_json TEXT,
      citations_json TEXT NOT NULL,
      events_json TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      -- Nullable on purpose: an unpriced model makes a run cost unknown, which is
      -- a different fact from costing zero. See src/config/model-prices.ts.
      cost_usd REAL,
      latency_ms INTEGER NOT NULL,
      models_json TEXT NOT NULL,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS run_spans (
      span_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
      parent_span_id TEXT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('run', 'node', 'tool', 'llm')),
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      error TEXT,
      attributes_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_run_spans_run_id ON run_spans(run_id);
    CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at DESC);
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
    db
      .prepare<[], { name: string }>(`PRAGMA table_info(chunks)`)
      .all()
      .map((c) => c.name),
  );

  if (!existing.has('source')) db.exec(`ALTER TABLE chunks ADD COLUMN source TEXT`);
  if (!existing.has('doc_id')) db.exec(`ALTER TABLE chunks ADD COLUMN doc_id TEXT`);
}

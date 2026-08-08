/**
 * Read-only inspector for the sqlite-vec index at database/app.db.
 *
 * Why this exists rather than a generic SQLite MCP server: `vec_chunks` is a vec0 virtual
 * table, so any client that has not loaded the sqlite-vec extension fails with
 * "no such module: vec0" on the one table worth looking at. This loads the extension the
 * same way src/database/database.module.ts does, so the vector side is actually visible.
 *
 * Opens the database read-only and rejects anything that is not a SELECT, so it can be
 * allowlisted in .claude/settings.json without giving an agent write access to the index.
 *
 *   node scripts/inspect-index.mjs stats
 *   node scripts/inspect-index.mjs schema [table]
 *   node scripts/inspect-index.mjs doc <docId-or-fragment>
 *   node scripts/inspect-index.mjs sql "select ..."
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = resolve(repoRoot, process.env.DATABASE_PATH ?? 'database/app.db');

if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Run a reindex first (POST /knowledge/reindex).`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
sqliteVec.load(db);

const [command, ...rest] = process.argv.slice(2);
const arg = rest.join(' ');

const table = (rows) => {
  if (rows.length === 0) return '(no rows)';
  const cols = Object.keys(rows[0]);
  const width = (c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').slice(0, 60).length));
  const line = (cells) => cells.map((c, i) => c.padEnd(width(cols[i]))).join('  ');
  return [
    line(cols),
    cols.map((c) => '-'.repeat(width(c))).join('  '),
    ...rows.map((r) => line(cols.map((c) => String(r[c] ?? '').slice(0, 60)))),
  ].join('\n');
};

const count = (sql) => {
  try {
    return db.prepare(sql).get().c;
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
};

switch (command) {
  case 'stats': {
    console.log(`database: ${dbPath}\n`);
    console.log(`articles:    ${count('select count(*) c from articles')}`);
    console.log(`chunks:      ${count('select count(*) c from chunks')}`);
    console.log(`vec_chunks:  ${count('select count(*) c from vec_chunks')}`);
    console.log(`index_state: ${count('select count(*) c from index_state')}\n`);

    // Per-source counts are the fastest way to spot a half-finished reindex: the corpus is
    // 82 mail / 47 chat / 40 notes, so anything else means indexing did not complete.
    try {
      console.log('chunks by source:');
      console.log(
        table(
          db
            .prepare('select source, count(*) as chunks from chunks group by source order by 1')
            .all(),
        ),
      );
    } catch (e) {
      console.log(`  (source column unavailable: ${e.message})`);
    }
    break;
  }

  case 'schema': {
    const rows = arg
      ? db.prepare('select sql from sqlite_master where name = ?').all(arg)
      : db
          .prepare("select name, type from sqlite_master where type in ('table','view') order by 1")
          .all();
    console.log(arg ? (rows[0]?.sql ?? '(not found)') : table(rows));
    break;
  }

  case 'doc': {
    if (!arg) {
      console.error('usage: doc <docId-or-fragment>');
      process.exit(1);
    }
    // "Is this chunk actually embedded?" is the question worth answering here — a chunk row
    // with no vector is invisible to retrieval. vec0 virtual tables reject a WHERE on
    // non-vector columns, so the embedded set is pulled out whole and matched in JS rather
    // than joined in SQL.
    const embedded = new Set(
      db
        .prepare('select chunk_id from vec_chunks')
        .all()
        .map((r) => r.chunk_id),
    );
    const rows = db
      .prepare(
        `select id, doc_id, source, chunk_index, length(text) as text_len
         from chunks where doc_id like ? order by doc_id, chunk_index limit 50`,
      )
      .all(`%${arg}%`);
    console.log(table(rows.map((r) => ({ ...r, embedded: embedded.has(r.id) ? 'yes' : 'NO' }))));
    break;
  }

  case 'sql': {
    // Read-only connection already blocks writes; this rejects them earlier and clearer,
    // and keeps the allowlisted command honest about what it can do.
    if (!/^\s*(select|with)\b/i.test(arg)) {
      console.error('Only SELECT / WITH queries are allowed.');
      process.exit(1);
    }
    console.log(table(db.prepare(arg).all()));
    break;
  }

  default:
    console.error(
      'usage: node scripts/inspect-index.mjs <stats|schema [table]|doc <id>|sql "select ...">',
    );
    process.exit(1);
}

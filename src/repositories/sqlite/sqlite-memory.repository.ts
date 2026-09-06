import { Inject, Injectable } from '@nestjs/common';
import Database from 'better-sqlite3';
import { SQLITE_CONNECTION } from '../../database/database.constants';
import {
  MEMORY_FUNNEL_STAGES,
  MEMORY_KINDS,
  type MemoryCandidate,
  type MemoryFact,
  type MemoryFunnel,
  type MemoryFunnelStage,
  type MemoryKind,
} from '../../memory/memory.types';
import type { FactOrigin, MemoryRepository, MemorySearchHit } from '../ports/memory.repository';

interface FactRow {
  id: number;
  text: string;
  kind: string;
  importance: number;
  access_count: number;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  source_run_id: string;
  source_session_id: string;
}

@Injectable()
export class SqliteMemoryRepository implements MemoryRepository {
  constructor(@Inject(SQLITE_CONNECTION) private readonly db: Database.Database) {}

  insert(candidate: MemoryCandidate, embedding: number[], origin: FactOrigin): Promise<MemoryFact> {
    const now = new Date().toISOString();

    // One transaction across both tables. `vec_memory_facts` is a virtual table
    // with no foreign key to `memory_facts`, so a half-written fact would be
    // either a row that can never be found by search or a vector pointing at
    // nothing — and the second kind survives every later query as a phantom hit.
    const write = this.db.transaction((): FactRow => {
      const result = this.db
        .prepare(
          `INSERT INTO memory_facts (
             text, kind, importance, access_count, created_at, updated_at,
             last_used_at, source_run_id, source_session_id
           ) VALUES (?, ?, ?, 1, ?, ?, NULL, ?, ?)`,
        )
        .run(
          candidate.text,
          candidate.kind,
          candidate.importance,
          now,
          now,
          origin.runId,
          origin.sessionId,
        );

      const id = Number(result.lastInsertRowid);
      this.db
        .prepare('INSERT INTO vec_memory_facts (fact_id, embedding) VALUES (?, ?)')
        .run(BigInt(id), JSON.stringify(embedding));

      return this.row(id)!;
    });

    return Promise.resolve(toFact(write()));
  }

  search(embedding: number[], topK: number): Promise<MemorySearchHit[]> {
    // No `sourceFilter` equivalent and therefore none of the over-fetch widening
    // `SqliteEmbeddingRepository.search` needs: this index holds only facts, so
    // vec0's own k-nearest is the whole answer. That simplicity is one of the
    // reasons facts are not in `vec_chunks` — see migrations.ts.
    const hits = this.db
      .prepare<[string, number], { fact_id: number; distance: number }>(
        `SELECT fact_id, distance FROM vec_memory_facts
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`,
      )
      .all(JSON.stringify(embedding), topK);

    const results: MemorySearchHit[] = [];
    for (const hit of hits) {
      const row = this.row(hit.fact_id);
      // A vector whose fact is gone means a delete that missed this table. Skip
      // it rather than inventing a fact, and let consolidation clean up.
      if (row) results.push({ fact: toFact(row), distance: hit.distance });
    }
    return Promise.resolve(results);
  }

  recordRestatement(factId: number): Promise<MemoryFact | null> {
    const changed = this.db
      .prepare(
        `UPDATE memory_facts
            SET access_count = access_count + 1, updated_at = ?
          WHERE id = ?`,
      )
      .run(new Date().toISOString(), factId);

    if (changed.changes === 0) return Promise.resolve(null);
    const row = this.row(factId);
    return Promise.resolve(row ? toFact(row) : null);
  }

  markUsed(factIds: number[]): Promise<void> {
    if (factIds.length === 0) return Promise.resolve();
    const now = new Date().toISOString();
    const stamp = this.db.prepare('UPDATE memory_facts SET last_used_at = ? WHERE id = ?');
    this.db.transaction((ids: number[]) => {
      for (const id of ids) stamp.run(now, id);
    })(factIds);
    return Promise.resolve();
  }

  all(): Promise<MemoryFact[]> {
    const rows = this.db
      .prepare<[], FactRow>('SELECT * FROM memory_facts ORDER BY created_at ASC')
      .all();
    return Promise.resolve(rows.map(toFact));
  }

  delete(factIds: number[]): Promise<void> {
    if (factIds.length === 0) return Promise.resolve();

    const deleteFact = this.db.prepare('DELETE FROM memory_facts WHERE id = ?');
    const deleteVector = this.db.prepare('DELETE FROM vec_memory_facts WHERE fact_id = ?');
    this.db.transaction((ids: number[]) => {
      for (const id of ids) {
        deleteFact.run(id);
        // Explicit: no cascade reaches a vec0 virtual table. Forgetting the fact
        // but keeping its vector leaves a hit that resolves to nothing.
        deleteVector.run(BigInt(id));
      }
    })(factIds);
    return Promise.resolve();
  }

  findUnusedSince(before: string): Promise<MemoryFact[]> {
    const rows = this.db
      .prepare<[string], FactRow>(
        // A fact that has never been used is judged on its age instead, or a
        // never-retrieved fact would be immortal — exactly backwards.
        `SELECT * FROM memory_facts WHERE COALESCE(last_used_at, created_at) < ?`,
      )
      .all(before);
    return Promise.resolve(rows.map(toFact));
  }

  countFacts(): Promise<number> {
    const row = this.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM memory_facts').get();
    return Promise.resolve(row?.n ?? 0);
  }

  incrementFunnel(stage: MemoryFunnelStage, by = 1): Promise<void> {
    if (by === 0) return Promise.resolve();
    this.db
      .prepare(
        `INSERT INTO memory_funnel (stage, count) VALUES (?, ?)
         ON CONFLICT(stage) DO UPDATE SET count = count + excluded.count`,
      )
      .run(stage, by);
    return Promise.resolve();
  }

  funnel(): Promise<MemoryFunnel> {
    const rows = this.db
      .prepare<[], { stage: string; count: number }>('SELECT stage, count FROM memory_funnel')
      .all();
    const counts = new Map(rows.map((row) => [row.stage, row.count]));

    // Built from the known stage list rather than from the rows, so a stage that
    // has never fired reads 0 instead of vanishing from the response.
    const funnel = {
      skippedNoSelfReference: 0,
      proposed: 0,
      droppedLowImportance: 0,
      mergedDuplicate: 0,
      stored: 0,
    };
    for (const stage of MEMORY_FUNNEL_STAGES) {
      funnel[stage] = counts.get(stage) ?? 0;
    }
    return Promise.resolve(funnel);
  }

  private row(id: number): FactRow | undefined {
    return this.db.prepare<[number], FactRow>('SELECT * FROM memory_facts WHERE id = ?').get(id);
  }
}

function toFact(row: FactRow): MemoryFact {
  return {
    id: row.id,
    text: row.text,
    kind: toKind(row.kind),
    importance: row.importance,
    accessCount: row.access_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    sourceRunId: row.source_run_id,
    sourceSessionId: row.source_session_id,
  };
}

/**
 * Narrows the stored kind rather than asserting it — the same reasoning as
 * `toSpanKind` in the trace repository. An unrecognised value means the row
 * predates the current set, and `preference` is the safe read: it is the kind
 * that only ever affects how an answer is framed.
 */
function toKind(kind: string): MemoryKind {
  return MEMORY_KINDS.find((candidate) => candidate === kind) ?? 'preference';
}

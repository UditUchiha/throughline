import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { AppConfigService } from '../../src/config/app-config.service';
import { DEFAULT_DATABASE_PATH } from '../../src/config/env.schema';
import { IndexingService } from '../../src/knowledge/indexing.service';
import { ToolRegistry } from '../../src/agent/tools/tool-registry';
import { GuardrailService } from '../../src/guardrails/guardrail.service';
import type { EvalOptions } from './cli';

/**
 * Boots the real application and points it at an isolated database.
 *
 * Two traits carried over from the original harness (PLAN.md §5/M6.1) because
 * they are what make an eval mean anything:
 *
 * 1. **A real Nest application context**, not mocks. The suite scores the wiring
 *    that ships — the same failover chain, the same tool registry, the same
 *    guardrails — rather than a parallel assembly that drifts from it.
 * 2. **A deterministic reindex first.** Every run starts by proving the index
 *    matches the corpus on disk. On a warm database this is free: 172 documents
 *    skip by checksum with no embedding calls. A non-zero `indexed` count is
 *    reported, because it means the numbers about to be produced come from an
 *    index that was stale a moment ago.
 *
 * Three environment decisions are made here rather than inherited, each written
 * into the results file so a number carries its own provenance.
 */

export interface EvalContext {
  app: INestApplicationContext;
  config: AppConfigService;
  toolNames: string[];
  /** Registered guardrail names, for the cache fingerprint. */
  guardrailNames: string[];
  /** True when the index had to be rebuilt — the numbers are from a fresh index. */
  reindexed: boolean;
}

/**
 * Sets the environment the suite runs under, before anything reads it.
 *
 * This is a runner, not application code: `src/config/` is still the only place
 * the *application* reads `process.env`, and every variable set here is declared
 * in `env.schema.ts` and validated at boot like any other. Setting them from a
 * script is the only way to configure a Nest context that has not started yet.
 *
 * ⚠️ **"Before anything reads it" is a real constraint, and it was broken here
 * for the whole of M6.** `@nestjs/config`'s `forRoot()` runs inside the
 * `@Module` decorator of `src/config/config.module.ts`, so it snapshots
 * `process.env` when that file is *imported* — not when Nest boots. A static
 * `import { AppModule }` at the top of this file therefore froze the
 * environment before `applyEnvironment` had run, and every variable below was
 * assigned into a `process.env` nobody would read again. The suite went on
 * writing traces into `database/app.db` while reporting an isolated copy, and
 * ran with the demo connector live while recording `connectors: false`.
 *
 * Two things keep it fixed: `AppModule` is loaded with a dynamic `import()`
 * *after* this function returns, and `verifyEnvironment` below checks the
 * settings actually landed instead of trusting that they did.
 */
function applyEnvironment(options: EvalOptions): void {
  process.env.DATABASE_PATH = options.database;

  // Connectors off by default, and this is the M5-to-M6 decision HANDOFF asks to
  // be made explicitly rather than inherited. `DEMO_MODE` defaults to *on*, so
  // simply booting registers `obsidian_search_notes` over a synthetic vault that
  // the answer key does not cover. A question could then be answered correctly
  // out of the vault and score as unsupported, and `requiredSources` would be
  // measuring source coverage against documents the ledger has never heard of.
  //
  // Both settings are defensible. Off is chosen because the suite's whole claim
  // is that its scores are derived from a hand-authored answer key, and a source
  // outside that key breaks the claim rather than extending it. `--connectors`
  // turns it back on for anyone measuring the connector itself, and the choice is
  // recorded in `results-latest.json` either way.
  process.env.DEMO_MODE = options.connectors ? 'true' : 'false';
  if (!options.connectors) process.env.MCP_SERVERS = '[]';

  // 59 runs is a lot of noise in a shared project, and a trace of an eval run is
  // rarely the trace anyone is looking for.
  if (!options.trace) process.env.LANGSMITH_TRACING = 'false';
}

/**
 * Confirms the settings in `applyEnvironment` actually reached the application.
 *
 * The check exists because trusting them failed silently for an entire
 * milestone, and failed in the worst available way: every number the suite
 * produced was plausible, internally consistent, and measured against a
 * different configuration than the one written beside it in
 * `results-latest.json`. A `connectors: false` in a results file is a claim
 * about the run, so it has to be verified against the running system rather
 * than echoed back from the flag that was supposed to cause it.
 *
 * It throws rather than warns. A suite that knows it is measuring the wrong
 * thing must not go on to spend ~350 model calls doing it.
 */
function verifyEnvironment(config: AppConfigService, options: EvalOptions): void {
  const mismatches: string[] = [];

  if (resolve(config.databasePath) !== resolve(options.database)) {
    mismatches.push(`DATABASE_PATH is "${config.databasePath}", expected "${options.database}"`);
  }
  if (config.demoMode !== options.connectors) {
    mismatches.push(`DEMO_MODE is ${config.demoMode}, expected ${options.connectors}`);
  }
  if (!options.connectors && config.mcpServers.length > 0) {
    mismatches.push(`${config.mcpServers.length} MCP server(s) configured with connectors off`);
  }

  if (mismatches.length > 0) {
    const detail = mismatches.map((line) => `  - ${line}`).join('\n');
    throw new Error(
      `The eval environment did not take effect:\n${detail}\n\n` +
        `Something imported src/config/config.module.ts before applyEnvironment() ran — ` +
        `@nestjs/config snapshots process.env inside its @Module decorator, so an import ` +
        `is enough. Load it with a dynamic import() after the environment is set.`,
    );
  }
}

/**
 * Copies the live database so eval traffic lands nowhere that ships.
 *
 * Every run writes to `runs` + `run_spans` (bounded by `TRACE_RETENTION_RUNS`,
 * default 200), to the checkpoint tables, and potentially to `memory_facts`. Two
 * full passes is ~118 runs; a third would start pruning real history — and §9
 * bakes `database/app.db` into the deployed image, so whatever the suite wrote
 * would ship inside it.
 *
 * A copy rather than a fresh database because the index is the expensive part:
 * rebuilding it means re-embedding 172 documents, and the point of the isolated
 * database is to protect the trace store, not to re-derive the corpus. `.backup()`
 * rather than `copyFileSync` because the connection runs in WAL mode — a plain
 * file copy of a `.db` whose `-wal` has not been checkpointed silently loses
 * whatever is still in the log.
 */
async function isolateDatabase(source: string, destination: string): Promise<'copied' | 'empty'> {
  mkdirSync(dirname(destination), { recursive: true });

  // A stale copy is worse than none: it would be an index built against a corpus
  // that has since changed, and the reindex below would only notice the documents
  // whose checksums moved.
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${destination}${suffix}`, { force: true });
  }

  if (!existsSync(source)) return 'empty';

  const db = new Database(source, { readonly: true });
  try {
    await db.backup(destination);
  } finally {
    db.close();
  }
  return 'copied';
}

export async function createEvalContext(options: EvalOptions): Promise<EvalContext> {
  // Read before `applyEnvironment` overwrites it — this is the database being
  // copied *from*, which is whatever the developer's own configuration points at.
  //
  // The one `process.env` *read* in the harness, and it is exempted by name in
  // scripts/check-conventions.mjs rather than by the gate happening not to look
  // here. It cannot go through `AppConfigService`: the value is needed to decide
  // what to copy before the Nest context that would provide it exists.  The
  // default comes from the schema so there is still only one of it.
  const liveDatabase = process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH;

  if (liveDatabase !== options.database) {
    const outcome = await isolateDatabase(liveDatabase, options.database);
    if (outcome === 'empty') {
      console.warn(
        `No database at ${liveDatabase} — the suite will index the corpus from scratch, ` +
          `which costs one embedding batch per document.`,
      );
    }
  }

  applyEnvironment(options);

  // Deferred on purpose — see the warning on `applyEnvironment`. A static
  // `import` at the top of this file would evaluate `config.module.ts`, and with
  // it the `process.env` snapshot, before a single setting above was made.
  //
  // `require` rather than `await import()`: under `module: nodenext` TypeScript
  // emits a genuine ESM dynamic import even from a CommonJS file, and Node's ESM
  // resolver will not take an extensionless specifier — so the obvious spelling
  // fails at runtime having looked correct. This is the one deferral in the
  // harness; the guard below is what catches it if it ever stops working.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AppModule } = require('../../src/app.module') as typeof import('../../src/app.module');

  const app = await NestFactory.createApplicationContext(AppModule, {
    // The suite prints its own progress; Nest's per-request logging would bury it.
    // Warnings and errors stay: a failover, an unpriced model or a skipped MCP
    // server all change what the numbers mean.
    logger: ['warn', 'error'],
    bufferLogs: false,
  });
  app.enableShutdownHooks();

  verifyEnvironment(app.get(AppConfigService), options);

  const summary = await app.get(IndexingService).reindexAll();
  if (summary.indexed.length > 0) {
    console.warn(
      `Index was stale: ${summary.indexed.length} document(s) re-indexed, ` +
        `${summary.skipped.length} unchanged, ${summary.removed.length} removed.`,
    );
  }

  return {
    app,
    config: app.get(AppConfigService),
    toolNames: app.get(ToolRegistry).names(),
    guardrailNames: app.get(GuardrailService).names(),
    reindexed: summary.indexed.length > 0,
  };
}

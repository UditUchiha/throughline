/**
 * Builds `database/app.db` from the corpus, ahead of time.
 *
 * This is PLAN.md §9's "bake the index into the image", and it is the step §9's
 * Dockerfile sketch called `dist/scripts/corpus-index.js` — a path that never
 * existed. It stays out of `dist/` deliberately: `tsconfig.build.json` includes
 * `src/**` only, and putting `scripts/` back in is what once made TypeScript
 * infer the repo root as `rootDir` and emit `dist/src/main.js`, breaking
 * `node dist/main` on a path nobody had exercised. The Docker builder stage has
 * dev dependencies anyway, so it runs this through ts-node like every other
 * script here.
 *
 * **Why bake rather than let the server index at boot.** `ReindexScheduler`
 * already reindexes on startup and skips unchanged files by checksum, so an
 * image with no database would eventually be correct. But every free host in
 * §9's table has an ephemeral filesystem: whatever the container writes is gone
 * on the next restart, and on Render's free tier a restart is every fifteen idle
 * minutes. That turns each cold start into ~172 embedding calls against a free
 * tier that answers ~20 per window — an instance that is not merely slow to wake
 * but rate-limited into uselessness for an hour afterwards.
 *
 * **It always builds a fresh file.** Two reasons, and the second is the one that
 * would bite. An index is a pure function of the corpus plus the vectors, so
 * rebuilding in place buys nothing; and `database/app.db` on a development
 * machine also holds traces, checkpoints and pending writes — 9.6MB of the
 * 14MB file, at last measurement, being questions the author happened to ask.
 * `TRACE_RETENTION_RUNS` bounds that table but does not empty it, so an image
 * built from an existing file would ship it. Building from scratch means there
 * is nothing to remember to clear.
 *
 * Usage:
 *   pnpm corpus:index                                  # → $DATABASE_PATH
 *   DATABASE_PATH=./database/x.db pnpm corpus:index    # → somewhere else
 *
 * The target comes from the environment rather than a `--out=` flag, and that is
 * not a style preference. `@nestjs/config` reads `process.env` inside the
 * `@Module` decorator of `src/config/config.module.ts`, which runs when that file
 * is *imported* — so a script that sets `process.env.DATABASE_PATH` in `main()`
 * has already missed its chance, and indexes cheerfully into the wrong database
 * while printing the right path. (That is not hypothetical: `evals/harness/`
 * carried the same bug through all of M6.)
 *
 * Keyless when `EMBEDDING_PROVIDER=precomputed`, which is how the image builds
 * it; with a network provider it costs one embedding call per batch instead.
 */

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppConfigService } from '../src/config/app-config.service';
import { DEFAULT_DATABASE_PATH } from '../src/config/env.schema';
import { IndexingService } from '../src/knowledge/indexing.service';
import { KnowledgeModule } from '../src/knowledge/knowledge.module';

async function main(): Promise<void> {
  // Read, never written — the same read `evals/harness/context.ts` documents,
  // and for the same reason: the file has to be gone before `DatabaseModule`'s
  // provider factory opens it, which happens before anything can ask
  // `AppConfigService` where it is. Reading the value Nest is about to read is
  // safe; assigning one it has already snapshotted is not.
  const target = resolve(process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH);
  removeExisting(target);

  const app = await NestFactory.createApplicationContext(KnowledgeModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    const config = app.get(AppConfigService);
    const indexing = app.get(IndexingService);

    process.stdout.write(
      `Indexing ${config.knowledgePath} → ${target}\n` +
        `  provider ${config.embeddingProvider}\n\n`,
    );

    const started = Date.now();
    const summary = await indexing.reindexAll();
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    if (summary.indexed.length === 0) {
      throw new Error(
        `Indexed nothing. "${config.knowledgePath}" has no documents, so the image would ` +
          `ship an empty index and every question would abstain.`,
      );
    }

    process.stdout.write(
      `\nIndexed ${summary.indexed.length} document(s), ` +
        `${summary.totalChunks} chunk(s) in ${seconds}s → ${target}\n`,
    );
  } finally {
    await app.close();
  }
}

/**
 * Clears the target and its write-ahead files.
 *
 * The `-wal` and `-shm` siblings matter: deleting only `app.db` leaves a WAL
 * belonging to a database that no longer exists, and sqlite will happily replay
 * it into the new one.
 */
function removeExisting(target: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const path = `${target}${suffix}`;
    if (existsSync(path)) rmSync(path);
  }
}

main().catch((error: unknown) => {
  new Logger('corpus-index').error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

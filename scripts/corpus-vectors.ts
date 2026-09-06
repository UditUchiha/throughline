/**
 * Embeds the corpus once and writes the vectors to a committed artifact.
 *
 * This is the half of the keyless build that is *not* keyless — it is the one
 * step that has to talk to the embedding provider, and it runs on a laptop when
 * the corpus changes rather than in Docker on every build. `pnpm corpus:index`
 * then assembles `database/app.db` from the corpus plus this file with no
 * network at all. PLAN.md §9 lists shipping a pre-built index as one of three
 * ways out of §11.4's superseded keyless-build decision; this is that option,
 * shipping the vectors rather than the database, because the vectors are the
 * only part of the index that cannot be recomputed offline and everything else
 * in it is already in git.
 *
 * Chunking is done by the same `loadMarkdownArticles` + `chunkText` the indexer
 * uses, so the keys here are the exact strings the indexer will look up. If they
 * ever stop matching, `pnpm corpus:index` fails on the first chunk rather than
 * building an index that is quietly a mixture of two corpora.
 *
 * Usage:
 *   pnpm corpus:vectors --from-index   # free: lift the vectors out of a built index
 *   pnpm corpus:vectors                # ~172 calls, batched; needs EMBEDDING_API_KEY
 *   pnpm corpus:vectors --check        # free: is the artifact complete and current?
 *
 * `--from-index` is the one to reach for when `database/app.db` already holds the
 * index, which on a development machine it does. The vectors in it were produced
 * by the same model against the same text, so lifting them out is not an
 * approximation of re-embedding — it is the identical numbers, and it costs
 * nothing. Re-embedding is for the case where no index exists yet.
 */

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AppConfigService } from '../src/config/app-config.service';
import { EmbeddingsModule } from '../src/embeddings/embeddings.module';
import { EMBEDDING_SERVICE } from '../src/embeddings/embedding.types';
import type { EmbeddingProvider } from '../src/embeddings/embedding.types';
import {
  encodeVector,
  vectorKey,
  type PrecomputedVectorFile,
} from '../src/embeddings/precomputed-embedding.provider';
import { chunkText } from '../src/knowledge/chunker';
import { loadMarkdownArticles } from '../src/knowledge/markdown-loader';

/**
 * Texts per embedding call. The provider accepts an array, and one call per
 * document would be 172 round trips against a free tier that counts requests
 * rather than inputs — the exact budget this script exists to spend only once.
 */
const BATCH_SIZE = 32;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const fromIndex = args.includes('--from-index');

  // `EmbeddingsModule` alone, and `createApplicationContext` rather than
  // `NestFactory.create`: this needs the configured embedding provider, not an
  // HTTP server, a scheduler or the MCP host. Booting AppModule would open the
  // database and kick off a background reindex as a side effect of a script
  // whose whole job is to write a JSON file. `AppConfigService` reaches it
  // anyway because `ConfigModule` is `@Global`.
  const app = await NestFactory.createApplicationContext(EmbeddingsModule, {
    logger: ['warn', 'error'],
  });

  try {
    const config = app.get(AppConfigService);
    const chunks = collectChunks(config);
    const outPath = resolve(config.embeddingVectorsPath);

    if (checkOnly) {
      reportCoverage(chunks, outPath);
      return;
    }

    const file = fromIndex
      ? liftFromIndex(config, chunks)
      : await embedAll(app.get<EmbeddingProvider>(EMBEDDING_SERVICE), config, chunks);

    mkdirSync(dirname(outPath), { recursive: true });
    // Newline-terminated and key-ordered by construction (insertion order follows
    // the corpus), so a regeneration that changed nothing produces no diff.
    writeFileSync(outPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');

    const kb = Math.round(Buffer.byteLength(JSON.stringify(file)) / 1024);
    process.stdout.write(
      `\nWrote ${Object.keys(file.vectors).length} vector(s) to ${outPath} (~${kb}KB).\n` +
        `Commit it — \`pnpm corpus:index\` and the Docker build read it instead of a provider.\n`,
    );
  } finally {
    await app.close();
  }
}

/**
 * Embeds every chunk with the configured provider.
 *
 * The identity written into the artifact comes off the provider rather than the
 * environment, so what the file claims about itself is what actually produced
 * the numbers.
 */
async function embedAll(
  embeddings: EmbeddingProvider,
  config: AppConfigService,
  chunks: string[],
): Promise<PrecomputedVectorFile> {
  if (config.embeddingProvider === 'precomputed') {
    throw new Error(
      'EMBEDDING_PROVIDER=precomputed cannot generate vectors — it replays them. Either ' +
        'run this with the provider that produced the index (gemini), or use --from-index.',
    );
  }

  const vectors: Record<string, string> = {};

  process.stdout.write(
    `Embedding ${chunks.length} chunk(s) with ${embeddings.modelId} ` +
      `(${embeddings.dimensions}d), ${BATCH_SIZE} per call…\n`,
  );

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const result = await embeddings.embed(batch);

    for (const [j, text] of batch.entries()) {
      const vector = result[j];
      if (vector.length !== embeddings.dimensions) {
        throw new Error(
          `Provider returned a ${vector.length}d vector but reports ${embeddings.dimensions}d`,
        );
      }
      vectors[vectorKey(text)] = encodeVector(vector);
    }

    process.stdout.write(`  ${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length}\n`);
  }

  return {
    modelId: embeddings.modelId,
    dimensions: embeddings.dimensions,
    generatedAt: new Date().toISOString(),
    vectors,
  };
}

/**
 * Lifts the vectors straight out of an existing sqlite-vec index.
 *
 * Free, and exact rather than equivalent: these are the numbers the index was
 * built from, so an artifact made this way reproduces that index bit for bit
 * instead of re-deriving something close to it.
 *
 * It reads sqlite directly, which application code may not do (PLAN.md §0.3) —
 * but this is a build tool running outside the Nest context, like
 * `scripts/inspect-index.mjs`, and the alternative was widening
 * `EmbeddingRepository` with a read-back method that nothing else would ever
 * call (§0.4).
 *
 * The identity comes out of `index_meta`, which is the same string the running
 * server checks itself against — so an artifact lifted from an index cannot
 * claim a model the index was not built with.
 */
function liftFromIndex(config: AppConfigService, chunks: string[]): PrecomputedVectorFile {
  const dbPath = resolve(config.databasePath);
  if (!existsSync(dbPath)) {
    throw new Error(
      `--from-index needs a built index at "${dbPath}". Build one first, or drop the flag ` +
        `to embed the corpus instead.`,
    );
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    sqliteVec.load(db);

    const identity = db
      .prepare<[], { value: string }>(
        `SELECT value FROM index_meta WHERE key = 'embedding_identity'`,
      )
      .get();

    if (!identity) {
      throw new Error(`"${dbPath}" has no embedding identity — it has never been indexed.`);
    }

    // "provider/model:dimensions" — the format embeddingIdentity() writes.
    const separator = identity.value.lastIndexOf(':');
    const modelId = identity.value.slice(0, separator);
    const dimensions = Number(identity.value.slice(separator + 1));

    const rows = db
      .prepare<[], { text: string; embedding: Buffer }>(
        `SELECT c.text AS text, v.embedding AS embedding FROM chunks c JOIN vec_chunks v ON v.chunk_id = c.id`,
      )
      .all();

    const byKey = new Map(
      rows.map((row) => [
        vectorKey(row.text),
        encodeVector(
          Array.from(
            new Float32Array(
              row.embedding.buffer,
              row.embedding.byteOffset,
              row.embedding.byteLength / 4,
            ),
          ),
        ),
      ]),
    );

    const vectors: Record<string, string> = {};
    const missing: string[] = [];

    // Walked in corpus order rather than index order, so the artifact only ever
    // carries what the build will ask for — an index holding chunks from a corpus
    // that has since changed contributes its stale rows to nothing.
    for (const text of chunks) {
      const key = vectorKey(text);
      const found = byKey.get(key);
      if (found) vectors[key] = found;
      else missing.push(text.slice(0, 80).replace(/\s+/g, ' '));
    }

    if (missing.length > 0) {
      throw new Error(
        `${missing.length} chunk(s) are not in "${dbPath}" — the index is older than the ` +
          `corpus. Reindex it, or drop --from-index. First: "${missing[0]}…"`,
      );
    }

    process.stdout.write(
      `Lifted ${Object.keys(vectors).length} vector(s) from ${dbPath} ` +
        `(${modelId}, ${dimensions}d) — no model calls.\n`,
    );

    return { modelId, dimensions, generatedAt: new Date().toISOString(), vectors };
  } finally {
    db.close();
  }
}

/** Every chunk the indexer will ask for, in corpus order. */
function collectChunks(config: AppConfigService): string[] {
  const articles = loadMarkdownArticles(config.knowledgePath);
  if (articles.length === 0) {
    throw new Error(`No documents under "${config.knowledgePath}" — nothing to embed.`);
  }

  return articles.flatMap((article) =>
    chunkText(article.content, config.chunkSize, config.chunkOverlap),
  );
}

/**
 * The staleness check, run in CI because it costs nothing.
 *
 * Reports both directions: a chunk with no vector is what breaks the build, and
 * a vector no chunk needs means the corpus shrank and the artifact is carrying
 * dead weight. Neither is inferable from the file alone.
 */
function reportCoverage(chunks: string[], outPath: string): void {
  if (!existsSync(outPath)) {
    throw new Error(`No vector artifact at "${outPath}" — run \`pnpm corpus:vectors\`.`);
  }

  const file = JSON.parse(readFileSync(outPath, 'utf8')) as PrecomputedVectorFile;
  const have = new Set(Object.keys(file.vectors));
  const need = chunks.map(vectorKey);

  const missing = need.filter((key) => !have.has(key)).length;
  const orphaned = [...have].filter((key) => !need.includes(key)).length;

  process.stdout.write(
    `${outPath}\n  model      ${file.modelId} (${file.dimensions}d)\n` +
      `  generated  ${file.generatedAt}\n` +
      `  chunks     ${chunks.length}\n  vectors    ${have.size}\n` +
      `  missing    ${missing}\n  orphaned   ${orphaned}\n`,
  );

  if (missing > 0) {
    throw new Error(
      `${missing} chunk(s) have no vector. The corpus or CHUNK_SIZE changed since the ` +
        `artifact was written — regenerate it with \`pnpm corpus:vectors\`.`,
    );
  }
}

main().catch((error: unknown) => {
  new Logger('corpus-vectors').error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

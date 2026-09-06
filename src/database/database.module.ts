import { Module, Logger } from '@nestjs/common';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { AppConfigService } from '../config/app-config.service';
import { SQLITE_CONNECTION } from './database.constants';
import { runMigrations } from './migrations';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import {
  EMBEDDING_SERVICE,
  embeddingIdentity,
  type EmbeddingProvider,
} from '../embeddings/embedding.types';

/**
 * Detect a stale index built by a different embedding model or dimensions.
 * First reindex writes the identity; subsequent boots compare it. A mismatch
 * means every stored vector is garbage for the current model, so we fail fast
 * with an actionable message rather than returning silently wrong results.
 */
function checkIndexIdentity(db: Database.Database, currentId: string, logger: Logger): void {
  const row = db
    .prepare<[], { value: string }>(`SELECT value FROM index_meta WHERE key = 'embedding_identity'`)
    .get();

  if (!row) {
    // First boot or freshly deleted DB — no index exists yet, nothing to mismatch.
    return;
  }

  if (row.value !== currentId) {
    throw new Error(
      `Embedding model mismatch: the index was built with "${row.value}", ` +
        `but the current config specifies "${currentId}". ` +
        `Delete ${db.name} and reindex, or change EMBEDDING_MODEL / EMBEDDING_DIMENSIONS to match.`,
    );
  }

  logger.debug(`Index identity check passed (${currentId})`);
}

@Module({
  imports: [EmbeddingsModule],
  providers: [
    {
      provide: SQLITE_CONNECTION,
      useFactory: (config: AppConfigService, embeddings: EmbeddingProvider): Database.Database => {
        const logger = new Logger('DatabaseModule');
        mkdirSync(dirname(config.databasePath), { recursive: true });

        const db = new Database(config.databasePath);
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        sqliteVec.load(db);

        // The provider's dimension count, not the configured one, for the same
        // reason as the identity below: `precomputed` takes both from the artifact,
        // and a vec_chunks table sized from a stale env var rejects every insert.
        runMigrations(db, embeddings.dimensions);
        // Read off the *provider*, which is the same object IndexingService writes
        // the identity from — so the two genuinely cannot drift. Reconstructing it
        // from `EMBEDDING_PROVIDER` + `EMBEDDING_MODEL` looked equivalent and was
        // not: `precomputed` replays vectors somebody else's model produced and
        // reports that model's identity, so a config-derived string would have
        // recorded `precomputed/...` for an index built by Gemini and refused to
        // boot against it.
        checkIndexIdentity(
          db,
          embeddingIdentity(embeddings.modelId, embeddings.dimensions),
          logger,
        );

        return db;
      },
      inject: [AppConfigService, EMBEDDING_SERVICE],
    },
  ],
  exports: [SQLITE_CONNECTION],
})
export class DatabaseModule {}

import { Module, Logger } from '@nestjs/common';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { AppConfigService } from '../config/app-config.service';
import { SQLITE_CONNECTION } from './database.constants';
import { runMigrations } from './migrations';
import { embeddingIdentity, embeddingModelId } from '../embeddings/embedding.types';

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
  providers: [
    {
      provide: SQLITE_CONNECTION,
      useFactory: (config: AppConfigService): Database.Database => {
        const logger = new Logger('DatabaseModule');
        mkdirSync(dirname(config.databasePath), { recursive: true });

        const db = new Database(config.databasePath);
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        sqliteVec.load(db);

        runMigrations(db, config.embeddingDimensions);
        // Built the same way IndexingService writes it, so the two cannot drift.
        checkIndexIdentity(
          db,
          embeddingIdentity(
            embeddingModelId(config.embeddingProvider, config.embeddingModel),
            config.embeddingDimensions,
          ),
          logger,
        );

        return db;
      },
      inject: [AppConfigService],
    },
  ],
  exports: [SQLITE_CONNECTION],
})
export class DatabaseModule {}

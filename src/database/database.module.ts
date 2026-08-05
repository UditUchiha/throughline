import { Module } from '@nestjs/common';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { AppConfigService } from '../config/app-config.service';
import { SQLITE_CONNECTION } from './database.constants';
import { runMigrations } from './migrations';

@Module({
  providers: [
    {
      provide: SQLITE_CONNECTION,
      useFactory: (config: AppConfigService): Database.Database => {
        mkdirSync(dirname(config.databasePath), { recursive: true });

        const db = new Database(config.databasePath);
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        sqliteVec.load(db);

        runMigrations(db, config.embeddingDimensions);

        return db;
      },
      inject: [AppConfigService],
    },
  ],
  exports: [SQLITE_CONNECTION],
})
export class DatabaseModule {}

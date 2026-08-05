import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import {
  ARTICLE_REPOSITORY,
  CHUNK_REPOSITORY,
  EMBEDDING_REPOSITORY,
  INDEX_STATE_REPOSITORY,
} from './ports/tokens';
import { SqliteArticleRepository } from './sqlite/sqlite-article.repository';
import { SqliteChunkRepository } from './sqlite/sqlite-chunk.repository';
import { SqliteEmbeddingRepository } from './sqlite/sqlite-embedding.repository';
import { SqliteIndexStateRepository } from './sqlite/sqlite-index-state.repository';

@Module({
  imports: [DatabaseModule],
  providers: [
    { provide: ARTICLE_REPOSITORY, useClass: SqliteArticleRepository },
    { provide: CHUNK_REPOSITORY, useClass: SqliteChunkRepository },
    { provide: EMBEDDING_REPOSITORY, useClass: SqliteEmbeddingRepository },
    { provide: INDEX_STATE_REPOSITORY, useClass: SqliteIndexStateRepository },
  ],
  exports: [ARTICLE_REPOSITORY, CHUNK_REPOSITORY, EMBEDDING_REPOSITORY, INDEX_STATE_REPOSITORY],
})
export class RepositoriesModule {}

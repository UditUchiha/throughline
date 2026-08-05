import { Module } from '@nestjs/common';
import { RepositoriesModule } from '../repositories/repositories.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { IndexingService } from './indexing.service';
import { KnowledgeController } from './knowledge.controller';

@Module({
  imports: [RepositoriesModule, EmbeddingsModule],
  controllers: [KnowledgeController],
  providers: [IndexingService],
  exports: [IndexingService],
})
export class KnowledgeModule {}

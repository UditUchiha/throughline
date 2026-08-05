import { Module } from '@nestjs/common';
import { RepositoriesModule } from '../repositories/repositories.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { RetrievalService } from './retrieval.service';
import { RagController } from './rag.controller';

@Module({
  imports: [RepositoriesModule, EmbeddingsModule],
  controllers: [RagController],
  providers: [RetrievalService],
  exports: [RetrievalService],
})
export class RagModule {}

import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ConfigModule } from '../config/config.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { RepositoriesModule } from '../repositories/repositories.module';
import { LongTermMemoryService } from './long-term-memory.service';
import { MemoryController } from './memory.controller';

@Module({
  imports: [ConfigModule, AiModule, EmbeddingsModule, RepositoriesModule],
  controllers: [MemoryController],
  providers: [LongTermMemoryService],
  exports: [LongTermMemoryService],
})
export class MemoryModule {}

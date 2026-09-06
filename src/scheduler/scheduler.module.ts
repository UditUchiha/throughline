import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { MemoryModule } from '../memory/memory.module';
import { MemoryConsolidationScheduler } from './memory-consolidation.scheduler';
import { ReindexScheduler } from './reindex.scheduler';

@Module({
  imports: [ScheduleModule.forRoot(), KnowledgeModule, MemoryModule],
  providers: [ReindexScheduler, MemoryConsolidationScheduler],
})
export class SchedulerModule {}

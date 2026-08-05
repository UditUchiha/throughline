import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ReindexScheduler } from './reindex.scheduler';

@Module({
  imports: [ScheduleModule.forRoot(), KnowledgeModule],
  providers: [ReindexScheduler],
})
export class SchedulerModule {}

import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { ConfigModule } from './config/config.module';
import { LoggerModule } from './logger/logger.module';
import { RepositoriesModule } from './repositories/repositories.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { RagModule } from './rag/rag.module';
import { AgentModule } from './agent/agent.module';
import { MemoryModule } from './memory/memory.module';
import { ObservabilityModule } from './observability/observability.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { ConflictsModule } from './conflicts/conflicts.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    RepositoriesModule,
    KnowledgeModule,
    RagModule,
    AgentModule,
    MemoryModule,
    ObservabilityModule,
    SchedulerModule,
    ConflictsModule,
  ],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}

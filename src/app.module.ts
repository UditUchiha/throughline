import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { ConfigModule } from './config/config.module';
import { LoggerModule } from './logger/logger.module';
import { RepositoriesModule } from './repositories/repositories.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { RagModule } from './rag/rag.module';
import { SchedulerModule } from './scheduler/scheduler.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    RepositoriesModule,
    KnowledgeModule,
    RagModule,
    SchedulerModule,
  ],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}

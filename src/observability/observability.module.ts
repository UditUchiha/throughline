import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { RepositoriesModule } from '../repositories/repositories.module';
import { LangSmithTracing } from './langsmith-tracing.service';
import { TraceCollector } from './trace-collector.service';
import { UsageService } from './usage.service';

/**
 * M3's three parts, together because they answer one question — what did that run
 * do, and what did it cost (PLAN.md §5/M3).
 *
 * Exported rather than self-contained because both of the other layers need
 * something here: `LlmModule` wraps its clients for tracing and prices its calls,
 * and `AgentModule` records the trace.
 */
@Module({
  imports: [ConfigModule, RepositoriesModule],
  providers: [LangSmithTracing, TraceCollector, UsageService],
  exports: [LangSmithTracing, TraceCollector, UsageService],
})
export class ObservabilityModule {}

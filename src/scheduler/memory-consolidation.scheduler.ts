import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AppConfigService } from '../config/app-config.service';
import { LongTermMemoryService } from '../memory/long-term-memory.service';

/**
 * Periodic memory consolidation (PLAN.md §5/M4.2), following `ReindexScheduler`
 * exactly — an interval registered with Nest's `SchedulerRegistry` on boot.
 *
 * Unlike the reindexer it does **not** run once at startup. A reindex at boot is
 * cheap and idempotent (unchanged files are skipped by checksum); consolidation
 * re-embeds every surviving fact, so running it on every restart would spend
 * embedding quota during development for a store that changes hourly at most.
 */
@Injectable()
export class MemoryConsolidationScheduler implements OnModuleInit {
  private readonly logger = new Logger(MemoryConsolidationScheduler.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly memory: LongTermMemoryService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    const interval = setInterval(
      () => void this.consolidate(),
      this.config.memoryConsolidationIntervalMs,
    );
    this.schedulerRegistry.addInterval('memory-consolidation', interval);
    this.logger.log(
      `Memory consolidation scheduled every ${this.config.memoryConsolidationIntervalMs}ms ` +
        `(forgetting facts unused for ${this.config.memoryTtlDays} days)`,
    );
  }

  private async consolidate(): Promise<void> {
    try {
      await this.memory.consolidate();
    } catch (error) {
      // Maintenance failing must not take the process down. The store is merely
      // larger than it should be until the next tick.
      this.logger.error('Memory consolidation failed', error);
    }
  }
}

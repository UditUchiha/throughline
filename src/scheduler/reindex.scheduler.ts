import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AppConfigService } from '../config/app-config.service';
import { IndexingService } from '../knowledge/indexing.service';

@Injectable()
export class ReindexScheduler implements OnModuleInit {
  private readonly logger = new Logger(ReindexScheduler.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly indexingService: IndexingService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    const interval = setInterval(() => this.runReindex(), this.config.reindexIntervalMs);
    this.schedulerRegistry.addInterval('background-reindex', interval);
    this.logger.log(`Background reindex scheduled every ${this.config.reindexIntervalMs}ms`);

    // Also run once at startup (non-blocking) so the index is fresh as soon as
    // the server boots instead of waiting a full interval. Cheap when nothing
    // changed: unchanged files are skipped by checksum. Failure (e.g. Ollama
    // not up yet) is logged, not fatal.
    void this.runReindex();
  }

  private async runReindex(): Promise<void> {
    try {
      const summary = await this.indexingService.reindexAll();
      this.logger.log(
        `Background reindex: indexed=${summary.indexed.length} skipped=${summary.skipped.length} removed=${summary.removed.length} chunks=${summary.totalChunks}`,
      );
    } catch (err) {
      this.logger.error('Background reindex failed', err);
    }
  }
}

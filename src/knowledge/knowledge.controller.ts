import { Controller, Post } from '@nestjs/common';
import { IndexingService, ReindexSummary } from './indexing.service';

@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly indexingService: IndexingService) {}

  @Post('reindex')
  async reindex(): Promise<ReindexSummary> {
    return this.indexingService.reindexAll();
  }
}

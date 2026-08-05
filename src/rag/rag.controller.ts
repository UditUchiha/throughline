import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { RetrievalService } from './retrieval.service';
import { RetrievedChunk } from './retrieved-chunk.type';

@Controller('knowledge')
export class RagController {
  constructor(private readonly retrievalService: RetrievalService) {}

  @Get('search')
  async search(
    @Query('q') query: string,
    @Query('k') topK?: string,
  ): Promise<{ query: string; results: RetrievedChunk[] }> {
    if (!query || query.trim().length === 0) {
      throw new BadRequestException('Query parameter "q" is required');
    }

    let k: number | undefined;
    if (topK !== undefined) {
      k = Number(topK);
      if (!Number.isInteger(k) || k < 1 || k > 50) {
        throw new BadRequestException('Query parameter "k" must be an integer between 1 and 50');
      }
    }

    const results = await this.retrievalService.search(query, k);
    return { query, results };
  }
}

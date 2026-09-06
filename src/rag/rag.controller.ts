import { Controller, Get, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RetrievalService } from './retrieval.service';
import { RetrievedChunk } from './retrieved-chunk.type';
import { searchQuerySchema, type SearchQuery } from './search-query.dto';

@Controller('knowledge')
export class RagController {
  constructor(private readonly retrievalService: RetrievalService) {}

  /**
   * The whole query object goes through the pipe rather than one parameter at a
   * time, because `@Query('q')` hands back `req.query['q']` with a *declared*
   * type and no check that the value matches it. Validating the object is what
   * makes the handler's `SearchQuery` true rather than hopeful.
   */
  @Get('search')
  async search(
    @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQuery,
  ): Promise<{ query: string; results: RetrievedChunk[] }> {
    const results = await this.retrievalService.search(query.q, query.k);
    return { query: query.q, results };
  }
}

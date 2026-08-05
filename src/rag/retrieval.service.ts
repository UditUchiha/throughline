import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { OllamaEmbeddingsService } from '../embeddings/ollama-embeddings.service';
import { ARTICLE_REPOSITORY, CHUNK_REPOSITORY, EMBEDDING_REPOSITORY } from '../repositories/ports/tokens';
import type { ArticleRepository } from '../repositories/ports/article.repository';
import type { ChunkRepository } from '../repositories/ports/chunk.repository';
import type { EmbeddingRepository } from '../repositories/ports/embedding.repository';
import { RetrievedChunk } from './retrieved-chunk.type';

@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly embeddingsService: OllamaEmbeddingsService,
    @Inject(ARTICLE_REPOSITORY) private readonly articleRepository: ArticleRepository,
    @Inject(CHUNK_REPOSITORY) private readonly chunkRepository: ChunkRepository,
    @Inject(EMBEDDING_REPOSITORY) private readonly embeddingRepository: EmbeddingRepository,
  ) {}

  async search(query: string, topK?: number): Promise<RetrievedChunk[]> {
    const start = Date.now();
    const [queryEmbedding] = await this.embeddingsService.embed([query]);
    const hits = await this.embeddingRepository.search(queryEmbedding, topK ?? this.config.topK);

    const chunks = await this.chunkRepository.findByIds(hits.map((h) => h.chunkId));
    const chunkById = new Map(chunks.map((c) => [c.id, c]));

    const articleIds = [...new Set(chunks.map((c) => c.articleId))];
    const articles = await Promise.all(articleIds.map((id) => this.articleRepository.findById(id)));
    const articleById = new Map(articles.filter((a) => a !== null).map((a) => [a.id, a]));

    const results: RetrievedChunk[] = hits
      .map((hit) => {
        const chunk = chunkById.get(hit.chunkId);
        if (!chunk) return null;
        const article = articleById.get(chunk.articleId);
        return {
          chunkId: chunk.id,
          articleId: chunk.articleId,
          articleTitle: article?.title ?? 'Unknown',
          text: chunk.text,
          distance: hit.distance,
        };
      })
      .filter((r): r is RetrievedChunk => r !== null);

    this.logger.debug(`Retrieved ${results.length} chunk(s) for query in ${Date.now() - start}ms`);
    return results;
  }
}

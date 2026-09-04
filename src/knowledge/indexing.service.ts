import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import {
  EMBEDDING_SERVICE,
  embeddingIdentity,
  type EmbeddingProvider,
} from '../embeddings/embedding.types';
import {
  ARTICLE_REPOSITORY,
  CHUNK_REPOSITORY,
  EMBEDDING_REPOSITORY,
  INDEX_STATE_REPOSITORY,
} from '../repositories/ports/tokens';
import type { ArticleRepository } from '../repositories/ports/article.repository';
import type { ChunkRepository } from '../repositories/ports/chunk.repository';
import type { EmbeddingRepository } from '../repositories/ports/embedding.repository';
import type { IndexStateRepository } from '../repositories/ports/index-state.repository';
import { chunkText } from './chunker';
import { loadMarkdownArticles } from './markdown-loader';

export interface ReindexSummary {
  indexed: string[];
  skipped: string[];
  removed: string[];
  totalChunks: number;
}

@Injectable()
export class IndexingService {
  private readonly logger = new Logger(IndexingService.name);

  constructor(
    private readonly config: AppConfigService,
    @Inject(EMBEDDING_SERVICE) private readonly embeddingsService: EmbeddingProvider,
    @Inject(ARTICLE_REPOSITORY)
    private readonly articleRepository: ArticleRepository,
    @Inject(CHUNK_REPOSITORY) private readonly chunkRepository: ChunkRepository,
    @Inject(EMBEDDING_REPOSITORY)
    private readonly embeddingRepository: EmbeddingRepository,
    @Inject(INDEX_STATE_REPOSITORY)
    private readonly indexStateRepository: IndexStateRepository,
  ) {}

  // A reindex mutates articles/chunks/embeddings across many statements with no
  // DB-level lock, so two concurrent runs (manual POST + background scheduler)
  // could interleave. If one is already running, callers share its result.
  private inFlight: Promise<ReindexSummary> | null = null;

  async reindexAll(): Promise<ReindexSummary> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doReindexAll().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doReindexAll(): Promise<ReindexSummary> {
    const articles = loadMarkdownArticles(this.config.knowledgePath);
    const summary: ReindexSummary = {
      indexed: [],
      skipped: [],
      removed: [],
      totalChunks: 0,
    };

    await this.removeDeletedArticles(articles, summary);

    for (const loaded of articles) {
      const existingState = await this.indexStateRepository.get(loaded.path);
      if (existingState && existingState.checksum === loaded.checksum) {
        summary.skipped.push(loaded.path);
        continue;
      }

      const existingArticle = await this.articleRepository.findByPath(loaded.path);
      if (existingArticle) {
        const oldChunks = await this.chunkRepository.findByArticleId(existingArticle.id);
        if (oldChunks.length > 0) {
          await this.embeddingRepository.deleteByChunkIds(oldChunks.map((c) => c.id));
        }
        await this.chunkRepository.deleteByArticleId(existingArticle.id);
      }

      const article = await this.articleRepository.upsert({
        title: loaded.title,
        path: loaded.path,
        checksum: loaded.checksum,
      });

      const texts = chunkText(loaded.content, this.config.chunkSize, this.config.chunkOverlap);
      const chunks = await this.chunkRepository.insertMany(
        article.id,
        texts.map((text, i) => ({
          chunkIndex: i,
          text,
          source: loaded.source ?? null,
          docId: loaded.docId ?? null,
        })),
      );

      const embeddings = await this.embeddingsService.embed(chunks.map((c) => c.text));
      await this.embeddingRepository.insertMany(
        chunks.map((c, i) => ({ chunkId: c.id, embedding: embeddings[i] })),
      );

      await this.indexStateRepository.upsert({
        path: loaded.path,
        lastIndexed: new Date().toISOString(),
        checksum: loaded.checksum,
      });

      this.logger.log(`Indexed "${loaded.path}" (${chunks.length} chunks)`);
      summary.indexed.push(loaded.path);
      summary.totalChunks += chunks.length;
    }

    if (summary.indexed.length > 0) {
      const identity = embeddingIdentity(
        this.embeddingsService.modelId,
        this.embeddingsService.dimensions,
      );
      await this.indexStateRepository.setMeta('embedding_identity', identity);
    }

    return summary;
  }

  /**
   * Knowledge files deleted from disk must also disappear from the index,
   * otherwise retrieval keeps serving chunks from articles that no longer exist.
   * The vec_chunks virtual table has no FK cascade, so embeddings are deleted
   * explicitly before the article row (which cascades to chunks).
   */
  private async removeDeletedArticles(
    articles: { path: string }[],
    summary: ReindexSummary,
  ): Promise<void> {
    const presentPaths = new Set(articles.map((a) => a.path));
    const states = await this.indexStateRepository.all();

    for (const state of states) {
      if (presentPaths.has(state.path)) continue;

      const article = await this.articleRepository.findByPath(state.path);
      if (article) {
        const chunks = await this.chunkRepository.findByArticleId(article.id);
        if (chunks.length > 0) {
          await this.embeddingRepository.deleteByChunkIds(chunks.map((c) => c.id));
        }
        await this.articleRepository.deleteById(article.id);
      }
      await this.indexStateRepository.delete(state.path);

      this.logger.log(`Removed deleted knowledge file "${state.path}" from index`);
      summary.removed.push(state.path);
    }
  }
}

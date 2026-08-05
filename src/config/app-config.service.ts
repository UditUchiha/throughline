import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from './env.schema';

@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService<EnvConfig, true>) {}

  get port(): number {
    return this.configService.get('PORT', { infer: true });
  }

  get ollamaUrl(): string {
    return this.configService.get('OLLAMA_URL', { infer: true });
  }

  get chatModel(): string {
    return this.configService.get('CHAT_MODEL', { infer: true });
  }

  get embeddingModel(): string {
    return this.configService.get('EMBEDDING_MODEL', { infer: true });
  }

  get embeddingDimensions(): number {
    return this.configService.get('EMBEDDING_DIMENSIONS', { infer: true });
  }

  get databasePath(): string {
    return this.configService.get('DATABASE_PATH', { infer: true });
  }

  get knowledgePath(): string {
    return this.configService.get('KNOWLEDGE_PATH', { infer: true });
  }

  get promptsPath(): string {
    return this.configService.get('PROMPTS_PATH', { infer: true });
  }

  get reindexIntervalMs(): number {
    return this.configService.get('REINDEX_INTERVAL_MS', { infer: true });
  }

  get topK(): number {
    return this.configService.get('TOP_K', { infer: true });
  }

  get chunkSize(): number {
    return this.configService.get('CHUNK_SIZE', { infer: true });
  }

  get chunkOverlap(): number {
    return this.configService.get('CHUNK_OVERLAP', { infer: true });
  }

  get retrievalDistanceThreshold(): number {
    return this.configService.get('RETRIEVAL_DISTANCE_THRESHOLD', { infer: true });
  }
}

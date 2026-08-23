import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from './env.schema';

export type LlmProvider = 'gemini' | 'groq' | 'openrouter' | 'ollama';
export type EmbeddingProviderType = 'gemini' | 'ollama';

@Injectable()
export class AppConfigService {
  constructor(private readonly configService: ConfigService<EnvConfig, true>) {}

  get port(): number {
    return this.configService.get('PORT', { infer: true });
  }

  // --- LLM ---

  get llmProvider(): LlmProvider {
    return this.configService.get('LLM_PROVIDER', { infer: true });
  }

  get llmApiKey(): string | undefined {
    return this.configService.get('LLM_API_KEY', { infer: true });
  }

  get llmModelFast(): string | undefined {
    return this.configService.get('LLM_MODEL_FAST', { infer: true });
  }

  get llmModelDefault(): string | undefined {
    return this.configService.get('LLM_MODEL_DEFAULT', { infer: true });
  }

  get llmModelDeep(): string | undefined {
    return this.configService.get('LLM_MODEL_DEEP', { infer: true });
  }

  // --- Embedding ---

  get embeddingProvider(): EmbeddingProviderType {
    return this.configService.get('EMBEDDING_PROVIDER', { infer: true });
  }

  get embeddingApiKey(): string | undefined {
    return this.configService.get('EMBEDDING_API_KEY', { infer: true });
  }

  get embeddingModel(): string {
    return this.configService.get('EMBEDDING_MODEL', { infer: true });
  }

  get embeddingDimensions(): number {
    return this.configService.get('EMBEDDING_DIMENSIONS', { infer: true });
  }

  // --- Ollama ---

  get ollamaUrl(): string {
    return this.configService.get('OLLAMA_URL', { infer: true });
  }

  get chatModel(): string {
    return this.configService.get('CHAT_MODEL', { infer: true });
  }

  // --- Paths ---

  get databasePath(): string {
    return this.configService.get('DATABASE_PATH', { infer: true });
  }

  get knowledgePath(): string {
    return this.configService.get('KNOWLEDGE_PATH', { infer: true });
  }

  get promptsPath(): string {
    return this.configService.get('PROMPTS_PATH', { infer: true });
  }

  // --- Indexing ---

  get reindexIntervalMs(): number {
    return this.configService.get('REINDEX_INTERVAL_MS', { infer: true });
  }

  // --- Retrieval ---

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

  // --- Agent ---

  get maxHops(): number {
    return this.configService.get('MAX_HOPS', { infer: true });
  }

  get maxFanOut(): number {
    return this.configService.get('MAX_FAN_OUT', { infer: true });
  }
}

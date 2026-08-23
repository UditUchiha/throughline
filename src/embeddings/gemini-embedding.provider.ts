import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { AppConfigService } from '../config/app-config.service';
import type { EmbeddingProvider } from './embedding.types';

@Injectable()
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  private readonly logger = new Logger(GeminiEmbeddingProvider.name);
  private readonly client: OpenAI;
  private readonly model: string;
  readonly dimensions: number;

  constructor(private readonly config: AppConfigService) {
    const apiKey = this.config.embeddingApiKey ?? this.config.llmApiKey;
    if (!apiKey) {
      throw new Error(
        'EMBEDDING_API_KEY (or LLM_API_KEY as fallback) is required when EMBEDDING_PROVIDER=gemini',
      );
    }

    this.client = new OpenAI({
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      apiKey,
    });
    this.model = this.config.embeddingModel;
    this.dimensions = this.config.embeddingDimensions;
    this.logger.log(`Embedding provider: gemini (${this.model}, ${this.dimensions}d)`);
  }

  get modelId(): string {
    return `gemini/${this.model}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const start = Date.now();
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
      dimensions: this.dimensions,
    });

    const embeddings = response.data.map((d) => d.embedding);
    this.logger.debug(`Embedded ${texts.length} text(s) in ${Date.now() - start}ms`);
    return embeddings;
  }
}

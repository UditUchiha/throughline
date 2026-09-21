import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { AppConfigService } from '../config/app-config.service';
import { embeddingModelId, type EmbeddingProvider } from './embedding.types';

@Injectable()
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  private readonly logger = new Logger(GeminiEmbeddingProvider.name);
  private readonly client: OpenAI;
  private readonly model: string;
  readonly dimensions: number;

  constructor(private readonly config: AppConfigService) {
    // `llmApiKeyFor` rather than the raw `llmApiKey`: it takes the first of a
    // comma-separated list, so a multi-key chat chain cannot hand this client an
    // unusable concatenation — and it consults GEMINI_API_KEY, which this
    // previously did not, so the Gemini key no longer has to be supplied twice
    // under two names to make retrieval work.
    const apiKey = this.config.embeddingApiKey ?? this.config.llmApiKeyFor('gemini');
    if (!apiKey) {
      throw new Error(
        'EMBEDDING_API_KEY (or GEMINI_API_KEY / LLM_API_KEY as fallback) is required when EMBEDDING_PROVIDER=gemini',
      );
    }

    this.client = new OpenAI({
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      apiKey,
      // A full reindex is 169 sequential calls; the free tier rate-limits per
      // minute, so without retries a reindex fails partway and leaves the index
      // half-built. See the same reasoning in OpenAICompatibleProvider.
      maxRetries: this.config.llmMaxRetries,
    });
    this.model = this.config.embeddingModel;
    this.dimensions = this.config.embeddingDimensions;
    this.logger.log(`Embedding provider: gemini (${this.model}, ${this.dimensions}d)`);
  }

  get modelId(): string {
    return embeddingModelId('gemini', this.model);
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];

    const start = Date.now();
    const response = await this.client.embeddings.create(
      {
        model: this.model,
        input: texts,
        dimensions: this.dimensions,
      },
      { signal },
    );

    const embeddings = response.data.map((d) => d.embedding);
    this.logger.debug(`Embedded ${texts.length} text(s) in ${Date.now() - start}ms`);
    return embeddings;
  }
}

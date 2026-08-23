import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import type { EmbeddingProvider } from './embedding.types';

interface OllamaEmbedResponse {
  embeddings: number[][];
}

@Injectable()
export class OllamaEmbeddingsService implements EmbeddingProvider {
  private readonly logger = new Logger(OllamaEmbeddingsService.name);
  readonly dimensions: number;
  private readonly model: string;

  constructor(private readonly config: AppConfigService) {
    this.model = this.config.embeddingModel;
    this.dimensions = this.config.embeddingDimensions;
    this.logger.log(`Embedding provider: ollama (${this.model}, ${this.dimensions}d)`);
  }

  get modelId(): string {
    return `ollama/${this.model}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const start = Date.now();
    const res = await fetch(`${this.config.ollamaUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!res.ok) {
      throw new Error(`Ollama embeddings request failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as OllamaEmbedResponse;
    this.logger.debug(`Embedded ${texts.length} text(s) in ${Date.now() - start}ms`);
    return data.embeddings;
  }
}

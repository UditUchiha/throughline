import { Module } from '@nestjs/common';
import { OllamaEmbeddingsService } from './ollama-embeddings.service';

@Module({
  providers: [OllamaEmbeddingsService],
  exports: [OllamaEmbeddingsService],
})
export class EmbeddingsModule {}

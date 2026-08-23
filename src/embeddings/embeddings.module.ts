import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/app-config.service';
import { EMBEDDING_SERVICE } from './embedding.types';
import { OllamaEmbeddingsService } from './ollama-embeddings.service';
import { GeminiEmbeddingProvider } from './gemini-embedding.provider';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: EMBEDDING_SERVICE,
      useFactory: (config: AppConfigService) => {
        switch (config.embeddingProvider) {
          case 'gemini':
            return new GeminiEmbeddingProvider(config);
          case 'ollama':
            return new OllamaEmbeddingsService(config);
          default:
            throw new Error(`Unknown EMBEDDING_PROVIDER: ${config.embeddingProvider}`);
        }
      },
      inject: [AppConfigService],
    },
  ],
  exports: [EMBEDDING_SERVICE],
})
export class EmbeddingsModule {}

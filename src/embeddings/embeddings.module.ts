import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/app-config.service';
import { EMBEDDING_SERVICE } from './embedding.types';
import { OllamaEmbeddingsService } from './ollama-embeddings.service';
import { GeminiEmbeddingProvider } from './gemini-embedding.provider';
import { PrecomputedEmbeddingProvider } from './precomputed-embedding.provider';

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
          case 'precomputed':
            return new PrecomputedEmbeddingProvider(config);
          default: {
            // Exhaustiveness check: adding a provider to the enum without a case
            // here becomes a compile error rather than a runtime surprise.
            const unhandled: never = config.embeddingProvider;
            throw new Error(`Unknown EMBEDDING_PROVIDER: ${String(unhandled)}`);
          }
        }
      },
      inject: [AppConfigService],
    },
  ],
  exports: [EMBEDDING_SERVICE],
})
export class EmbeddingsModule {}

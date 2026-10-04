import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/app-config.service';
import { EMBEDDING_SERVICE } from './embedding.types';
import { OllamaEmbeddingsService } from './ollama-embeddings.service';
import { GeminiEmbeddingProvider } from './gemini-embedding.provider';
import { FailoverEmbeddingProvider } from './failover-embedding.provider';
import { PrecomputedEmbeddingProvider } from './precomputed-embedding.provider';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: EMBEDDING_SERVICE,
      useFactory: (config: AppConfigService) => {
        switch (config.embeddingProvider) {
          case 'gemini': {
            // One client per configured key, so retrieval survives a rate-limited
            // credential the way chat already did. Unnumbered and unwrapped while
            // there is only one, which keeps the common setup a single client and
            // the log line it always printed.
            const keys = config.embeddingApiKeys;
            if (keys.length <= 1) return new GeminiEmbeddingProvider(config);

            return new FailoverEmbeddingProvider(
              keys.map(
                (key, index) => new GeminiEmbeddingProvider(config, key, `gemini#${index + 1}`),
              ),
            );
          }
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

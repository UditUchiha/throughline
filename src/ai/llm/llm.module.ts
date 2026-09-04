import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { AppConfigService, type LlmProvider } from '../../config/app-config.service';
import { FailoverLlmService } from './failover-llm.service';
import { LLM_SERVICE } from './llm.constants';
import { OpenAICompatibleProvider } from './openai-compatible.provider';

/**
 * Builds the ordered provider chain: the primary from `LLM_PROVIDER`, then each
 * entry of `LLM_FALLBACK_PROVIDERS`.
 *
 * A fallback with no API key is skipped with a warning rather than failing the
 * boot — someone who lists `groq` but has not created a key yet should still get
 * a working app on their primary provider. The primary is different: if it has no
 * key, nothing works, so that is a hard error.
 */
function buildProviderChain(config: AppConfigService): OpenAICompatibleProvider[] {
  const logger = new Logger('LlmModule');
  const primary = config.llmProvider;

  const primaryKey = config.llmApiKeyFor(primary);
  if (!primaryKey) {
    throw new Error(
      `No API key for LLM_PROVIDER=${primary}. Set ${primary.toUpperCase()}_API_KEY or LLM_API_KEY.`,
    );
  }

  const chain = [new OpenAICompatibleProvider(config, primary, primaryKey, true)];
  const seen = new Set<LlmProvider>([primary]);

  for (const fallback of config.llmFallbackProviders) {
    if (seen.has(fallback)) continue;
    seen.add(fallback);

    const key = config.llmApiKeyFor(fallback);
    if (!key) {
      logger.warn(
        `Skipping fallback provider "${fallback}": no ${fallback.toUpperCase()}_API_KEY configured`,
      );
      continue;
    }
    chain.push(new OpenAICompatibleProvider(config, fallback, key, false));
  }

  return chain;
}

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: LLM_SERVICE,
      useFactory: (config: AppConfigService) => new FailoverLlmService(buildProviderChain(config)),
      inject: [AppConfigService],
    },
  ],
  exports: [LLM_SERVICE],
})
export class LlmModule {}

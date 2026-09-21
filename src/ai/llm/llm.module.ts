import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { AppConfigService, type LlmProvider } from '../../config/app-config.service';
import { FailoverLlmService } from './failover-llm.service';
import { LLM_SERVICE } from './llm.constants';
import { OpenAICompatibleProvider } from './openai-compatible.provider';
import { ObservabilityModule } from '../../observability/observability.module';
import { LangSmithTracing } from '../../observability/langsmith-tracing.service';
import { UsageService } from '../../observability/usage.service';

/**
 * Builds the ordered provider chain: the primary from `LLM_PROVIDER`, then each
 * entry of `LLM_FALLBACK_PROVIDERS`.
 *
 * **One provider contributes one hop per configured key.** A free tier's quota is
 * per credential, so a second Gemini key is cheaper headroom than falling through
 * to another vendor — and a better measurement, because §11 found Groq returning
 * 2 citations where Gemini returned 5 on the same question. A chain that reaches
 * a different vendor early does not merely slow down; it starts measuring a
 * different model. `GEMINI_API_KEY=a,b,c` with `LLM_FALLBACK_PROVIDERS=groq`
 * therefore yields gemini#1 → gemini#2 → gemini#3 → groq.
 *
 * A fallback with no API key is skipped with a warning rather than failing the
 * boot — someone who lists `groq` but has not created a key yet should still get
 * a working app on their primary provider. The primary is different: if it has no
 * key, nothing works, so that is a hard error.
 */
function buildProviderChain(
  config: AppConfigService,
  usage: UsageService,
  tracing: LangSmithTracing,
): OpenAICompatibleProvider[] {
  const logger = new Logger('LlmModule');
  const primary = config.llmProvider;

  const primaryKeys = config.llmApiKeysFor(primary);
  if (primaryKeys.length === 0) {
    throw new Error(
      `No API key for LLM_PROVIDER=${primary}. Set ${primary.toUpperCase()}_API_KEY or LLM_API_KEY.`,
    );
  }

  const hops = (provider: LlmProvider, keys: string[], isPrimary: boolean) =>
    keys.map(
      (key, index) =>
        new OpenAICompatibleProvider(
          config,
          provider,
          key,
          isPrimary,
          usage,
          tracing,
          // Unnumbered while there is only one, so the common single-key setup
          // keeps logging "gemini" rather than the noisier "gemini#1".
          keys.length > 1 ? `${provider}#${index + 1}` : provider,
        ),
    );

  const chain = hops(primary, primaryKeys, true);
  const seen = new Set<LlmProvider>([primary]);

  for (const fallback of config.llmFallbackProviders) {
    if (seen.has(fallback)) continue;
    seen.add(fallback);

    const keys = config.llmApiKeysFor(fallback);
    if (keys.length === 0) {
      logger.warn(
        `Skipping fallback provider "${fallback}": no ${fallback.toUpperCase()}_API_KEY configured`,
      );
      continue;
    }
    chain.push(...hops(fallback, keys, false));
  }

  return chain;
}

@Module({
  imports: [ConfigModule, ObservabilityModule],
  providers: [
    {
      provide: LLM_SERVICE,
      useFactory: (config: AppConfigService, usage: UsageService, tracing: LangSmithTracing) =>
        new FailoverLlmService(buildProviderChain(config, usage, tracing)),
      inject: [AppConfigService, UsageService, LangSmithTracing],
    },
  ],
  exports: [LLM_SERVICE],
})
export class LlmModule {}

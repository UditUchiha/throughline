import { Logger } from '@nestjs/common';
import { isRetryableProviderError } from '../../common/retryable-provider-error';
import type { ChatMessage, ChatOptions, ChatResult, LlmService } from './llm.types';
import { QuotaExceededError, type OpenAICompatibleProvider } from './openai-compatible.provider';

/**
 * Raised when the chain is exhausted — every configured provider refused.
 *
 * Typed, and carrying `quotaOnly`, because §9's degraded demo has to tell one
 * exhausted chain from another. "All providers are out of budget" is the case
 * where replaying a recording is the honest response; "all providers are
 * unreachable" is a network fault, and serving a fixture for it would present an
 * infrastructure problem as a working demo. Reading that distinction back out of
 * the message string would work right up until someone reworded the message.
 */
export class AllProvidersFailedError extends Error {
  constructor(
    message: string,
    readonly quotaOnly: boolean,
  ) {
    super(message);
    this.name = 'AllProvidersFailedError';
  }
}

/**
 * Tries each configured provider in order until one answers.
 *
 * This exists because free tiers are small and the failure is not hypothetical:
 * measured on Gemini's free tier, a burst of agent runs exhausted the quota and
 * killed roughly half of them. Retrying harder makes that *worse* — every attempt
 * counts against the same budget — so the only real answer is another provider.
 * PLAN.md §9 asks for exactly this.
 *
 * It fails over on "this provider cannot serve you right now" (quota, 5xx,
 * connection failure) and rethrows immediately on anything else. A malformed
 * request or an unknown model is not fixed by asking a different vendor the same
 * bad question, and silently trying three providers would just triple the latency
 * before showing the same error.
 */
export class FailoverLlmService implements LlmService {
  private readonly logger = new Logger(FailoverLlmService.name);

  constructor(private readonly providers: OpenAICompatibleProvider[]) {
    if (providers.length === 0) {
      throw new Error(
        'No LLM provider is configured. Set LLM_PROVIDER and its API key (or LLM_API_KEY).',
      );
    }
    const names = providers.map((p) => p.label);
    this.logger.log(
      names.length > 1 ? `LLM chain: ${names.join(' → ')}` : `LLM provider: ${names[0]}`,
    );
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const failures: string[] = [];
    // Tracked as the loop runs rather than inferred from `failures` afterwards:
    // by then the errors are strings, and "was this quota?" is not a question a
    // message should have to answer.
    let quotaOnly = true;

    for (const [index, provider] of this.providers.entries()) {
      try {
        const result = await provider.chat(messages, options);
        if (index > 0) {
          this.logger.log(`Served by fallback provider "${provider.label}"`);
        }
        return result;
      } catch (error) {
        if (!isRetryableOnAnotherProvider(error)) throw error;

        if (!(error instanceof QuotaExceededError)) quotaOnly = false;
        failures.push(`${provider.label}: ${errorMessage(error)}`);
        const next = this.providers[index + 1];
        this.logger.warn(
          next
            ? `Provider "${provider.label}" unavailable, falling back to "${next.label}"`
            : `Provider "${provider.label}" unavailable and no fallback remains`,
        );
      }
    }

    throw new AllProvidersFailedError(
      `Every configured LLM provider failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`,
      quotaOnly,
    );
  }
}

/**
 * True when the failure is about *this hop's* availability rather than the
 * request.
 *
 * `QuotaExceededError` is this layer's own wrapper around a 429 and is checked
 * here; everything else is the shared rule, which embeddings use too.
 */
function isRetryableOnAnotherProvider(error: unknown): boolean {
  if (error instanceof QuotaExceededError) return true;
  return isRetryableProviderError(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

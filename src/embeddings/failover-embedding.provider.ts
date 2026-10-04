import { Logger } from '@nestjs/common';
import { isRetryableProviderError } from '../common/retryable-provider-error';
import type { EmbeddingProvider } from './embedding.types';

/**
 * Raised when every configured embedding credential refused.
 *
 * Distinct from returning an empty result, which is what the absence of this
 * used to look like from the outside: retrieval with no vector matches nothing,
 * so a quota wall arrived as *zero evidence* rather than an error, and the agent
 * dutifully answered from nothing. An exhausted chain must be loud.
 */
export class AllEmbeddingKeysFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllEmbeddingKeysFailedError';
  }
}

/**
 * Tries each embedding credential in order until one answers.
 *
 * The sibling of `FailoverLlmService`, and it exists for a failure that was
 * measured rather than imagined. On 2026-09-21 the first of five Gemini keys was
 * rate-limited: chat failed over to the second and kept answering, embeddings had
 * no chain and stayed pinned to the first, and all 59 eval questions failed with
 * `recall 0/1` while the answers themselves looked healthy. Chat failing over
 * *without* embeddings doing the same is worse than neither failing over, because
 * the run keeps producing confident output over an empty evidence set.
 *
 * One embedding call per search and several searches per question means a single
 * key cannot carry a full pass, so this is the difference between a measurement
 * completing and a measurement dying halfway.
 *
 * Deliberately not `@Injectable()`: like the LLM chain, several of these are
 * constructed by the module factory rather than resolved from the container.
 */
export class FailoverEmbeddingProvider implements EmbeddingProvider {
  private readonly logger = new Logger(FailoverEmbeddingProvider.name);

  constructor(private readonly providers: (EmbeddingProvider & { label: string })[]) {
    if (providers.length === 0) {
      throw new Error('No embedding credential is configured.');
    }
    this.logger.log(`Embedding chain: ${providers.map((p) => p.label).join(' → ')}`);
  }

  /**
   * Taken from the first hop rather than compared across them.
   *
   * Every hop is the same model behind a different credential, so they cannot
   * disagree — and if they somehow did, the `index_meta` identity guard catches
   * it at boot, which is the check that already owns this question.
   */
  get dimensions(): number {
    return this.providers[0].dimensions;
  }

  get modelId(): string {
    return this.providers[0].modelId;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];

    const failures: string[] = [];

    for (const [index, provider] of this.providers.entries()) {
      try {
        const vectors = await provider.embed(texts, signal);
        if (index > 0) {
          this.logger.log(`Embedded by fallback credential "${provider.label}"`);
        }
        return vectors;
      } catch (error) {
        if (!isRetryableProviderError(error)) throw error;

        failures.push(`${provider.label}: ${errorMessage(error)}`);
        const next = this.providers[index + 1];
        this.logger.warn(
          next
            ? `Embedding credential "${provider.label}" unavailable, falling back to "${next.label}"`
            : `Embedding credential "${provider.label}" unavailable and no fallback remains`,
        );
      }
    }

    throw new AllEmbeddingKeysFailedError(
      `Every configured embedding credential failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

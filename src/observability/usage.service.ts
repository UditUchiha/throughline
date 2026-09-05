import { Injectable, Logger } from '@nestjs/common';
import type { LlmProvider } from '../config/app-config.service';
import { priceFor } from '../config/model-prices';

/** What one model call consumed. Mirrors `ChatResult.usage`. */
export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Turns token counts into money (PLAN.md §5/M3.3).
 *
 * Injectable rather than a bare function only because of the warn-once log: an
 * unpriced model is a silent `null` everywhere downstream, and the one place that
 * can say *which* model is missing is here. That needs state, and state needs an
 * owner.
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);
  /** Models already reported as unpriced, so a run does not log the same line 4x. */
  private readonly reported = new Set<string>();

  /**
   * Estimated USD for one call, or `null` when the model has no published price
   * in `model-prices.ts`.
   *
   * `null` rather than `0` is load-bearing. A run that made one unpriced call has
   * an unknown cost, and `recordUsage` propagates that to the whole run — because
   * a total that silently omits a call reads as authoritative while being wrong,
   * which is the one failure mode worth designing against here.
   */
  costOf(provider: LlmProvider, model: string, usage: CallUsage): number | null {
    const price = priceFor(provider, model);

    if (!price) {
      const key = `${provider}/${model}`;
      if (!this.reported.has(key)) {
        this.reported.add(key);
        this.logger.warn(
          `No price for "${key}" — runs served by it will report cost as unknown. ` +
            `Add it to src/config/model-prices.ts to price them.`,
        );
      }
      return null;
    }

    return (
      (usage.inputTokens / 1_000_000) * price.inputPerMillion +
      (usage.outputTokens / 1_000_000) * price.outputPerMillion
    );
  }
}

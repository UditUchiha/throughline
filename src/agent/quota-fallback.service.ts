import { Injectable, Logger } from '@nestjs/common';
import { AllProvidersFailedError } from '../ai/llm/failover-llm.service';
import { AppConfigService } from '../config/app-config.service';

/**
 * Remembers that every provider was out of quota, so the next visitor gets a
 * recording instead of a failure.
 *
 * PLAN.md §9: *"if all fail, serve a recorded run via `?demo=1` with an honest
 * banner. A demo that degrades gracefully is more impressive than one that
 * 500s."* Half of that already worked — the event contract has carried
 * `run_replayed.reason: 'quota_exhausted'` since M2 and the UI's `ReplayBanner`
 * branches on it — but nothing in the API had ever set it, so the arm was live
 * and unreachable.
 *
 * **Why a window and not a mid-run switch.** `run_replayed` is documented as the
 * first event of a replayed run, and that is the honesty mechanism rather than a
 * formatting detail: a consumer cannot mistake a recording for a live run
 * because the recording announces itself before anything else arrives. A run
 * that fails halfway and then starts replaying would have to emit it fourth,
 * after `run_started` and a `run_failed` — and the UI's reducer would merge the
 * abandoned run's evidence into the recording's. So the run that hits the wall
 * reports its failure honestly, and it is the *next* request that replays, from
 * its first event.
 *
 * **Why time-based and not a probe.** Finding out whether the quota has come
 * back costs a model call, which is precisely the thing there is none of. The
 * window expires on its own; a success inside it closes the breaker early,
 * which happens whenever a fallback provider recovers first.
 */
@Injectable()
export class QuotaFallbackService {
  private readonly logger = new Logger(QuotaFallbackService.name);

  /** Epoch ms until which live runs are diverted; null when the breaker is closed. */
  private openUntil: number | null = null;

  constructor(private readonly config: AppConfigService) {}

  /** True while a recorded run should be served in place of a live one. */
  get isOpen(): boolean {
    if (this.openUntil === null) return false;
    if (Date.now() < this.openUntil) return true;

    this.openUntil = null;
    this.logger.log('Quota cooldown expired — serving live runs again');
    return false;
  }

  /** A run completed, so whatever refused earlier is answering again. */
  recordSuccess(): void {
    if (this.openUntil === null) return;
    this.openUntil = null;
    this.logger.log('A live run succeeded — quota fallback disarmed');
  }

  /**
   * Arms the fallback if — and only if — this failure was the whole chain
   * refusing on quota.
   *
   * Anything else is left alone deliberately. A timeout, an aborted request, a
   * malformed prompt or one provider being unreachable are all failures a
   * recording would paper over, and a demo that answers an outage with a
   * cheerful fixture is dishonest in the exact way the banner exists to prevent.
   */
  recordFailure(error: unknown): void {
    if (!(error instanceof AllProvidersFailedError) || !error.quotaOnly) return;

    this.openUntil = Date.now() + this.config.quotaFallbackCooldownMs;
    this.logger.warn(
      `Every provider is out of quota — replaying recorded runs for the next ` +
        `${Math.round(this.config.quotaFallbackCooldownMs / 1000)}s`,
    );
  }
}

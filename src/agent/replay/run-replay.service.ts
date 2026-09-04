import { Injectable, Logger } from '@nestjs/common';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { AppConfigService } from '../../config/app-config.service';
import type { AgentEvent, AgentEventSink } from '../events';
import {
  eventDelaysMs,
  fixtureDurationMs,
  isRunFixture,
  normaliseQuestion,
  type RunFixture,
  type RunFixtureSummary,
} from './run-fixture';

/** A captured run that paused this long did so waiting on a provider, not for effect. */
const MAX_GAP_MS = 2_000;

/**
 * Serves recorded runs.
 *
 * Two jobs, one mechanism. PLAN.md §9 wants a recorded run when the free tier is
 * exhausted mid-demo — "a demo that degrades gracefully is more impressive than
 * one that 500s". The same fixtures let the UI be built and tested without
 * spending model calls, which matters because one live run costs ~4 of them
 * against a quota measured in tens per minute.
 *
 * Fixtures are re-read when the directory changes on disk. Caching them at boot
 * seemed fine until `pnpm capture:runs` wrote new ones and the running server
 * kept serving the old set: `nest start --watch` watches `src/`, not `fixtures/`,
 * so nothing restarted and the staleness was silent.
 */
@Injectable()
export class RunReplayService {
  private readonly logger = new Logger(RunReplayService.name);
  private readonly bySlug = new Map<string, RunFixture>();
  private readonly byQuestion = new Map<string, RunFixture>();

  /** Newest mtime seen; a change means someone captured or edited a fixture. */
  private loadedStamp = -1;

  constructor(private readonly config: AppConfigService) {
    this.load(this.config.demoRunsPath);
  }

  /**
   * Reloads only when the directory's newest mtime has moved. Cheap enough to do
   * on every lookup — these are a handful of small files and demo requests are
   * user-initiated, not a hot path.
   */
  private refresh(): void {
    const dir = this.config.demoRunsPath;
    if (!existsSync(dir)) return;

    const stamp = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .reduce((newest, f) => Math.max(newest, statSync(join(dir, f)).mtimeMs), 0);

    if (stamp !== this.loadedStamp) {
      this.bySlug.clear();
      this.byQuestion.clear();
      this.load(dir);
    }
  }

  private load(dir: string): void {
    this.loadedStamp = -1;

    if (!existsSync(dir)) {
      // Not an error: a fresh clone has no fixtures until someone captures them.
      this.logger.warn(`No recorded runs at "${dir}" — POST /agent/ask?demo=1 will 404`);
      return;
    }

    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const path = join(dir, file);
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (!isRunFixture(parsed)) {
          this.logger.warn(`Skipping "${file}": not a recorded run`);
          continue;
        }
        const fixture: RunFixture = { ...parsed, slug: basename(file, '.json') };
        this.bySlug.set(fixture.slug, fixture);
        this.byQuestion.set(normaliseQuestion(fixture.question), fixture);
      } catch (error) {
        this.logger.warn(`Skipping "${file}": ${error instanceof Error ? error.message : error}`);
      }
    }

    this.loadedStamp = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .reduce((newest, f) => Math.max(newest, statSync(join(dir, f)).mtimeMs), 0);

    this.logger.log(`Loaded ${this.bySlug.size} recorded run(s) from ${dir}`);
  }

  list(): RunFixtureSummary[] {
    this.refresh();
    return [...this.bySlug.values()].map((fixture) => ({
      slug: fixture.slug,
      question: fixture.question,
      label: fixture.label,
      capturedAt: fixture.capturedAt,
      durationMs: fixtureDurationMs(fixture.events),
      eventCount: fixture.events.length,
    }));
  }

  find(questionOrSlug: string): RunFixture | undefined {
    this.refresh();
    return (
      this.bySlug.get(questionOrSlug) ?? this.byQuestion.get(normaliseQuestion(questionOrSlug))
    );
  }

  get size(): number {
    this.refresh();
    return this.bySlug.size;
  }

  /**
   * Streams a fixture, re-timed to the original spacing.
   *
   * `seq` and `ts` are re-stamped so a consumer computing elapsed time sees this
   * replay rather than the moment of capture; the true capture time travels in
   * the leading `run_replayed` event, which is what keeps the replay honest.
   */
  async replay(
    fixture: RunFixture,
    sink: AgentEventSink,
    options: { reason: 'requested' | 'quota_exhausted'; signal?: AbortSignal } = {
      reason: 'requested',
    },
  ): Promise<void> {
    let seq = 0;
    // Typed as the bare `AgentEvent` union rather than an Omit of the emitted
    // type: `Omit` does not distribute over a union, so it would flatten every
    // variant down to the one property they share.
    const emit = (event: AgentEvent): void => {
      sink({ ...event, seq: seq++, ts: new Date().toISOString() });
    };

    emit({
      type: 'run_replayed',
      slug: fixture.slug,
      question: fixture.question,
      capturedAt: fixture.capturedAt,
      reason: options.reason,
    });

    const delays = eventDelaysMs(fixture.events, MAX_GAP_MS);

    for (const [index, event] of fixture.events.entries()) {
      if (options.signal?.aborted) return;
      if (delays[index] > 0) await sleep(delays[index], options.signal);
      if (options.signal?.aborted) return;
      // Re-stamped by `emit`; the recorded seq/ts are deliberately discarded so a
      // consumer measuring elapsed time sees this replay, not the capture.
      emit(event);
    }
  }
}

/** Resolves early when the caller hangs up, so a closed tab does not hold the timer. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

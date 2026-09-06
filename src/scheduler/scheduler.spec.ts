import type { SchedulerRegistry } from '@nestjs/schedule';
import type { AppConfigService } from '../config/app-config.service';
import type { IndexingService } from '../knowledge/indexing.service';
import type { LongTermMemoryService } from '../memory/long-term-memory.service';
import { MemoryConsolidationScheduler } from './memory-consolidation.scheduler';
import { ReindexScheduler } from './reindex.scheduler';

/**
 * Both schedulers exist to run work that must never take the process down, and
 * both were untested. The interesting behaviour is entirely in what they do when
 * the work fails or is switched off — an unhandled rejection inside a
 * `setInterval` callback is a crashed container, and on a free tier a crashed
 * container is a cold start plus a wasted wake.
 */

function registry(): { registry: SchedulerRegistry; names: string[]; intervals: NodeJS.Timeout[] } {
  const names: string[] = [];
  const intervals: NodeJS.Timeout[] = [];
  return {
    names,
    intervals,
    registry: {
      addInterval: (name: string, interval: NodeJS.Timeout) => {
        names.push(name);
        intervals.push(interval);
      },
    } as unknown as SchedulerRegistry,
  };
}

describe('ReindexScheduler', () => {
  const config = { reindexIntervalMs: 60_000 } as AppConfigService;

  it('registers the interval and reindexes once at boot', async () => {
    const { registry: reg, names, intervals } = registry();
    let calls = 0;
    const indexing = {
      reindexAll: () => {
        calls += 1;
        return Promise.resolve({ indexed: [], skipped: ['a'], removed: [], totalChunks: 0 });
      },
    } as unknown as IndexingService;

    new ReindexScheduler(config, indexing, reg).onModuleInit();
    // The boot pass is deliberately not awaited by `onModuleInit`, so the server
    // starts listening rather than waiting on the index.
    await Promise.resolve();

    expect(names).toEqual(['background-reindex']);
    expect(calls).toBe(1);
    intervals.forEach(clearInterval);
  });

  it('survives a failing boot reindex instead of taking the process down', async () => {
    // This is the path the new empty-corpus guard throws down. A rejection here
    // must be logged and swallowed — the index is stale, which is recoverable;
    // a dead container is not.
    const { registry: reg, intervals } = registry();
    const indexing = {
      reindexAll: () => Promise.reject(new Error('Refusing to reindex: no documents found')),
    } as unknown as IndexingService;

    const scheduler = new ReindexScheduler(config, indexing, reg);

    expect(() => scheduler.onModuleInit()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    intervals.forEach(clearInterval);
  });
});

describe('MemoryConsolidationScheduler', () => {
  const enabled = {
    longTermMemory: true,
    memoryConsolidationIntervalMs: 60_000,
    memoryTtlDays: 30,
  } as AppConfigService;

  it('registers an interval when long-term memory is on', () => {
    const { registry: reg, names, intervals } = registry();
    const memory = { consolidate: () => Promise.resolve() } as unknown as LongTermMemoryService;

    new MemoryConsolidationScheduler(enabled, memory, reg).onModuleInit();

    expect(names).toEqual(['memory-consolidation']);
    intervals.forEach(clearInterval);
  });

  it('registers no interval at all when long-term memory is off', () => {
    // Not a no-op tick: `SchedulerRegistry` should not list maintenance for a
    // store nothing writes to, and consolidation costs one embedding call per
    // surviving fact every six hours (PLAN.md §9).
    const { registry: reg, names } = registry();
    const memory = { consolidate: () => Promise.resolve() } as unknown as LongTermMemoryService;

    new MemoryConsolidationScheduler(
      { ...enabled, longTermMemory: false } as AppConfigService,
      memory,
      reg,
    ).onModuleInit();

    expect(names).toEqual([]);
  });

  it('does not consolidate at boot, unlike the reindexer', () => {
    // A reindex at boot is free when nothing changed; consolidation re-embeds
    // every surviving fact, so running it on each restart would spend embedding
    // quota during development.
    const { registry: reg, intervals } = registry();
    let calls = 0;
    const memory = {
      consolidate: () => {
        calls += 1;
        return Promise.resolve();
      },
    } as unknown as LongTermMemoryService;

    new MemoryConsolidationScheduler(enabled, memory, reg).onModuleInit();

    expect(calls).toBe(0);
    intervals.forEach(clearInterval);
  });
});

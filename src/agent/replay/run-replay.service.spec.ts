import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfigService } from '../../config/app-config.service';
import type { EmittedAgentEvent } from '../events';
import { RunReplayService } from './run-replay.service';
import { eventDelaysMs, normaliseQuestion } from './run-fixture';

function event(type: string, seq: number, msOffset: number, extra: object = {}): EmittedAgentEvent {
  return {
    type,
    seq,
    ts: new Date(Date.parse('2026-09-04T00:00:00.000Z') + msOffset).toISOString(),
    ...extra,
  } as EmittedAgentEvent;
}

const FIXTURE_EVENTS = [
  event('run_started', 0, 0, { runId: 'r1', question: 'Why did Helios slip?' }),
  event('triage_done', 1, 20, { complexity: 'complex', reasoning: 'two sources' }),
  event('run_finished', 2, 40, {
    answer: {
      text: 'Because [1].',
      citations: [{ marker: 1, evidenceId: 'ev-1' }],
      abstained: false,
    },
    citations: [{ marker: 1, evidenceId: 'ev-1' }],
    usage: { inputTokens: 10, outputTokens: 5 },
    costUsd: null,
    latencyMs: 40,
  }),
];

function makeFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'throughline-fixtures-'));
  writeFileSync(
    join(dir, 'multihop-helios-delay.json'),
    JSON.stringify({
      question: 'Why did Helios slip?',
      label: 'Multi-hop',
      capturedAt: '2026-09-04T00:00:00.000Z',
      events: FIXTURE_EVENTS,
    }),
  );
  writeFileSync(join(dir, 'not-a-run.json'), JSON.stringify({ nonsense: true }));
  writeFileSync(join(dir, 'broken.json'), '{ this is not json');
  return dir;
}

function serviceFor(dir: string): RunReplayService {
  return new RunReplayService({ demoRunsPath: dir } as unknown as AppConfigService);
}

describe('RunReplayService', () => {
  let dir: string;

  beforeAll(() => {
    dir = makeFixtureDir();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads valid fixtures and ignores malformed ones without failing boot', () => {
    const service = serviceFor(dir);

    expect(service.size).toBe(1);
    expect(service.list()[0]).toMatchObject({
      slug: 'multihop-helios-delay',
      label: 'Multi-hop',
      eventCount: 3,
      durationMs: 40,
    });
  });

  it('survives a missing fixtures directory', () => {
    const service = serviceFor(join(dir, 'does-not-exist'));
    expect(service.size).toBe(0);
    expect(service.list()).toEqual([]);
  });

  // Regression: fixtures were cached at boot, so a fresh `pnpm capture:runs` left
  // the running server serving the old set. `nest start --watch` watches src/,
  // not fixtures/, so nothing restarted and the staleness was invisible.
  it('picks up a fixture written after construction', () => {
    const service = serviceFor(dir);
    expect(service.size).toBe(1);

    writeFileSync(
      join(dir, 'captured-later.json'),
      JSON.stringify({
        question: 'Added after boot',
        capturedAt: '2026-09-04T01:00:00.000Z',
        events: FIXTURE_EVENTS,
      }),
    );

    expect(service.size).toBe(2);
    expect(service.find('Added after boot')?.slug).toBe('captured-later');
    rmSync(join(dir, 'captured-later.json'));
  });

  it('finds a fixture by slug or by loosely-matched question', () => {
    const service = serviceFor(dir);

    expect(service.find('multihop-helios-delay')?.slug).toBe('multihop-helios-delay');
    // Punctuation and case differ from the recorded question on purpose.
    expect(service.find('why did helios slip')?.slug).toBe('multihop-helios-delay');
    expect(service.find('something else entirely')).toBeUndefined();
  });

  // The honesty requirement from PLAN.md §9: a recording must never be able to
  // pass itself off as a live run.
  it('announces itself with run_replayed before any recorded event', async () => {
    const service = serviceFor(dir);
    const seen: EmittedAgentEvent[] = [];

    await service.replay(service.find('multihop-helios-delay')!, (e) => seen.push(e));

    expect(seen[0].type).toBe('run_replayed');
    expect(seen[0]).toMatchObject({
      slug: 'multihop-helios-delay',
      capturedAt: '2026-09-04T00:00:00.000Z',
      reason: 'requested',
    });
    expect(seen.slice(1).map((e) => e.type)).toEqual([
      'run_started',
      'triage_done',
      'run_finished',
    ]);
  });

  it('re-stamps seq and ts so elapsed time reflects the replay, not the capture', async () => {
    const service = serviceFor(dir);
    const seen: EmittedAgentEvent[] = [];

    await service.replay(service.find('multihop-helios-delay')!, (e) => seen.push(e));

    expect(seen.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    for (const e of seen) {
      expect(Date.parse(e.ts)).toBeGreaterThan(Date.parse('2026-09-04T00:00:00.000Z'));
    }
  });

  it('stops early when the caller hangs up', async () => {
    const service = serviceFor(dir);
    const seen: EmittedAgentEvent[] = [];
    const controller = new AbortController();
    controller.abort();

    await service.replay(service.find('multihop-helios-delay')!, (e) => seen.push(e), {
      reason: 'requested',
      signal: controller.signal,
    });

    // The announcement is emitted before the loop checks the signal; nothing else is.
    expect(seen.map((e) => e.type)).toEqual(['run_replayed']);
  });
});

describe('run fixture helpers', () => {
  it('preserves the original spacing between events', () => {
    expect(eventDelaysMs(FIXTURE_EVENTS, 2_000)).toEqual([0, 20, 20]);
  });

  // A capture that stalled on a slow provider should not make the demo stall too.
  it('clamps a long stall so a replay does not reproduce it', () => {
    const stalled = [event('a', 0, 0), event('b', 1, 30_000)];
    expect(eventDelaysMs(stalled, 2_000)).toEqual([0, 2_000]);
  });

  it('matches questions ignoring case and punctuation', () => {
    expect(normaliseQuestion('Why did Helios slip, really?')).toBe('why did helios slip really');
  });
});

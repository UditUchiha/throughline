import { TraceCollector, type TraceInput } from './trace-collector.service';
import type { PersistedRun, RunSpan } from '../common/types/trace.types';
import type { TraceRepository } from '../repositories/ports/trace.repository';
import type { EmittedAgentEvent } from '../agent/events';

class FakeTraceRepository implements TraceRepository {
  readonly saved: { run: PersistedRun; spans: RunSpan[] }[] = [];

  save(run: PersistedRun, spans: RunSpan[]): Promise<void> {
    this.saved.push({ run, spans });
    return Promise.resolve();
  }

  get(runId: string): Promise<{ run: PersistedRun; spans: RunSpan[] } | null> {
    return Promise.resolve(this.saved.find((entry) => entry.run.runId === runId) ?? null);
  }
}

const T0 = Date.parse('2026-09-05T10:00:00.000Z');
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

function toolStarted(id: string, tool: string, ms: number): EmittedAgentEvent {
  return { type: 'tool_started', subQuestionId: id, tool, input: 'query', seq: 0, ts: at(ms) };
}

function toolFinished(
  id: string,
  tool: string,
  ms: number,
  extra: { latencyMs: number; evidenceIds?: string[]; error?: string },
): EmittedAgentEvent {
  return {
    type: 'tool_finished',
    subQuestionId: id,
    tool,
    evidenceIds: extra.evidenceIds ?? [],
    latencyMs: extra.latencyMs,
    ...(extra.error === undefined ? {} : { error: extra.error }),
    seq: 0,
    ts: at(ms),
  };
}

function nodeSpan(name: string, startMs: number, endMs: number, spanId: string): RunSpan {
  return {
    spanId,
    parentSpanId: 'root',
    name,
    kind: 'node',
    startedAt: at(startMs),
    endedAt: at(endMs),
    durationMs: endMs - startMs,
    error: null,
    attributes: {},
  };
}

function input(overrides: Partial<TraceInput> = {}): TraceInput {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    question: 'why did it slip?',
    startedAt: at(0),
    status: 'finished',
    answer: { text: 'because [1]', citations: [], abstained: false },
    citations: [],
    events: [],
    usage: { inputTokens: 100, outputTokens: 20 },
    costUsd: 0.001,
    latencyMs: 5_000,
    models: ['gemini/gemini-3.5-flash'],
    error: null,
    spans: [],
    rootSpanId: 'root',
    ...overrides,
  };
}

describe('TraceCollector', () => {
  it('writes a root span covering the whole run', async () => {
    const repo = new FakeTraceRepository();
    await new TraceCollector(repo).record(input());

    const [{ run, spans }] = repo.saved;
    const root = spans.find((span) => span.kind === 'run');

    expect(root).toMatchObject({ spanId: 'root', parentSpanId: null, durationMs: 5_000 });
    expect(run.finishedAt).toBe(at(5_000));
  });

  it('derives one tool span per retrieval call', async () => {
    const repo = new FakeTraceRepository();
    await new TraceCollector(repo).record(
      input({
        events: [
          toolStarted('sq1', 'mail_search', 100),
          toolFinished('sq1', 'mail_search', 700, { latencyMs: 600, evidenceIds: ['ev-1'] }),
        ],
      }),
    );

    const tools = repo.saved[0].spans.filter((span) => span.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: 'mail_search',
      startedAt: at(100),
      endedAt: at(700),
      durationMs: 600,
      error: null,
    });
    expect(tools[0].attributes).toMatchObject({ subQuestionId: 'sq1', evidenceCount: 1 });
  });

  it('keeps two concurrent calls to the same tool apart', async () => {
    // `execute` fans out in parallel and two sub-questions routinely pick the same
    // tool, so keying pending spans by tool name would interleave them into one.
    const repo = new FakeTraceRepository();
    await new TraceCollector(repo).record(
      input({
        events: [
          toolStarted('sq1', 'mail_search', 100),
          toolStarted('sq2', 'mail_search', 110),
          toolFinished('sq2', 'mail_search', 500, { latencyMs: 390 }),
          toolFinished('sq1', 'mail_search', 900, { latencyMs: 800 }),
        ],
      }),
    );

    const tools = repo.saved[0].spans.filter((span) => span.kind === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools.map((span) => span.attributes.subQuestionId).sort()).toEqual(['sq1', 'sq2']);

    const sq1 = tools.find((span) => span.attributes.subQuestionId === 'sq1');
    expect(sq1).toMatchObject({ startedAt: at(100), endedAt: at(900) });
  });

  it('records a tool call whose start event is missing', async () => {
    // Not a shape `execute` produces — every path there emits both events, the
    // unknown-tool one included. This pins the defensive branch for a truncated
    // event list, because a tool call dropped from a trace for being malformed
    // reads as one that never happened.
    const repo = new FakeTraceRepository();
    await new TraceCollector(repo).record(
      input({
        events: [toolFinished('sq9', 'ghost_search', 300, { latencyMs: 0, error: 'No such tool' })],
      }),
    );

    const tools = repo.saved[0].spans.filter((span) => span.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ error: 'No such tool', durationMs: 0, startedAt: at(300) });
  });

  it('parents each tool span to the node that was running', async () => {
    const repo = new FakeTraceRepository();
    await new TraceCollector(repo).record(
      input({
        spans: [nodeSpan('execute', 50, 1_000, 'node-execute')],
        events: [
          toolStarted('sq1', 'mail_search', 100),
          toolFinished('sq1', 'mail_search', 700, { latencyMs: 600 }),
        ],
      }),
    );

    const tool = repo.saved[0].spans.find((span) => span.kind === 'tool');
    expect(tool?.parentSpanId).toBe('node-execute');
  });

  it('parents a second-hop tool to the second execute, not the first', async () => {
    // `execute` runs again when reflection finds a gap. Resolving the parent by
    // node *name* would put every tool under the first pass and flatten the hop
    // structure the trace exists to show.
    const repo = new FakeTraceRepository();
    await new TraceCollector(repo).record(
      input({
        spans: [
          nodeSpan('execute', 50, 1_000, 'node-execute-1'),
          nodeSpan('reflect', 1_000, 2_000, 'node-reflect'),
          nodeSpan('execute', 2_000, 3_000, 'node-execute-2'),
        ],
        events: [
          toolStarted('sq1', 'mail_search', 100),
          toolFinished('sq1', 'mail_search', 700, { latencyMs: 600 }),
          toolStarted('sq3', 'notes_search', 2_100),
          toolFinished('sq3', 'notes_search', 2_600, { latencyMs: 500 }),
        ],
      }),
    );

    const tools = repo.saved[0].spans.filter((span) => span.kind === 'tool');
    const hop1 = tools.find((span) => span.attributes.subQuestionId === 'sq1');
    const hop2 = tools.find((span) => span.attributes.subQuestionId === 'sq3');

    expect(hop1?.parentSpanId).toBe('node-execute-1');
    expect(hop2?.parentSpanId).toBe('node-execute-2');
  });

  it('falls back to the root when no node encloses a tool call', async () => {
    const repo = new FakeTraceRepository();
    await new TraceCollector(repo).record(
      input({
        events: [
          toolStarted('sq1', 'mail_search', 100),
          toolFinished('sq1', 'mail_search', 700, { latencyMs: 600 }),
        ],
      }),
    );

    expect(repo.saved[0].spans.find((span) => span.kind === 'tool')?.parentSpanId).toBe('root');
  });

  it('persists a failed run', async () => {
    const repo = new FakeTraceRepository();
    await new TraceCollector(repo).record(
      input({ status: 'failed', answer: null, error: 'quota exhausted' }),
    );

    const [{ run, spans }] = repo.saved;
    expect(run).toMatchObject({ status: 'failed', answer: null, error: 'quota exhausted' });
    expect(spans.find((span) => span.kind === 'run')?.error).toBe('quota exhausted');
  });

  it('never lets a storage failure escape', async () => {
    // A trace is a record *about* a run. Losing one is a gap in observability; it
    // must not become a failed request for the visitor who made the run.
    const failing: TraceRepository = {
      save: () => Promise.reject(new Error('disk is full')),
      get: () => Promise.resolve(null),
    };

    await expect(new TraceCollector(failing).record(input())).resolves.toBeUndefined();
  });
});

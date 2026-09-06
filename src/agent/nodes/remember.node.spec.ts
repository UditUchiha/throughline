import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { LongTermMemoryService } from '../../memory/long-term-memory.service';
import type { MemoryFact } from '../../memory/memory.types';
import { AGENT_RUN_CONTEXT, type AgentRunContext } from '../agent-run-context';
import type { AgentAnswer } from '../agent.types';
import type { EmittedAgentEvent } from '../events';
import type { AgentState } from '../state';
import { RememberNode } from './remember.node';

function fact(id: number, overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id,
    text: 'The user prefers answers with citations.',
    kind: 'preference',
    importance: 0.8,
    accessCount: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    lastUsedAt: null,
    sourceRunId: 'run-1',
    sourceSessionId: 'session-1',
    ...overrides,
  };
}

function stubMemory(outcome: { stored?: MemoryFact[]; merged?: MemoryFact[] } = {}): {
  memory: LongTermMemoryService;
  exchanges: { question: string; answer: string }[];
} {
  const exchanges: { question: string; answer: string }[] = [];
  const memory = {
    remember: (exchange: { question: string; answer: string }) => {
      exchanges.push(exchange);
      return Promise.resolve({ stored: outcome.stored ?? [], merged: outcome.merged ?? [] });
    },
  } as unknown as LongTermMemoryService;
  return { memory, exchanges };
}

function graphConfig(signal?: AbortSignal): {
  config: LangGraphRunnableConfig;
  emitted: EmittedAgentEvent[];
} {
  const emitted: EmittedAgentEvent[] = [];
  const context: AgentRunContext = {
    runId: 'run-1',
    sessionId: 'session-1',
    sink: (event) => emitted.push(event),
    signal: signal ?? new AbortController().signal,
    counter: { seq: 0 },
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    models: [],
    spans: [],
    rootSpanId: 'span-root',
    activeNodeSpanId: null,
  };
  return { config: { configurable: { [AGENT_RUN_CONTEXT]: context } }, emitted };
}

const ANSWERED: AgentAnswer = {
  text: 'Priya Raman approved it [1].',
  citations: [{ marker: 1, evidenceId: 'ev-1' }],
  abstained: false,
};

function state(answer: AgentAnswer | null, overrides: Partial<AgentState> = {}): AgentState {
  return {
    question: 'Who approved the new Helios launch date?',
    askedQuestion: 'Who approved it?',
    sessionId: 'session-1',
    runId: 'run-1',
    complexity: 'simple',
    subQuestions: [],
    evidence: [],
    memoryUsed: [],
    hops: 1,
    answer,
    events: [],
    turns: [],
    ...overrides,
  };
}

describe('RememberNode', () => {
  it('extracts from the question as the visitor typed it', async () => {
    const { memory, exchanges } = stubMemory({ stored: [fact(1)] });
    const { config } = graphConfig();

    await new RememberNode(memory).run(state(ANSWERED), config);

    // Not the resolved rewrite: extraction is looking for what the *person* said
    // about themselves, and the rewrite is our words, assembled from earlier turns.
    expect(exchanges).toEqual([
      { question: 'Who approved it?', answer: 'Priya Raman approved it [1].' },
    ]);
  });

  it('announces stored facts as written memory', async () => {
    const { memory } = stubMemory({ stored: [fact(7)] });
    const { config, emitted } = graphConfig();

    await new RememberNode(memory).run(state(ANSWERED), config);

    const written = emitted.find((event) => event.type === 'memory_written');
    expect(written?.refs).toEqual([
      { id: 'fact-7', kind: 'preference', text: 'The user prefers answers with citations.' },
    ]);
  });

  it('reports a merged fact as a restatement, with its count', async () => {
    const { memory } = stubMemory({ merged: [fact(7, { accessCount: 3 })] });
    const { config, emitted } = graphConfig();

    await new RememberNode(memory).run(state(ANSWERED), config);

    // A merge is not a new row, but memory did change — showing nothing would
    // suggest the run had been ignored.
    const written = emitted.find((event) => event.type === 'memory_written');
    expect(written?.refs[0].kind).toBe('preference · restated ×3');
  });

  it('says nothing when the run produced nothing worth keeping', async () => {
    const { memory } = stubMemory();
    const { config, emitted } = graphConfig();

    const update = await new RememberNode(memory).run(state(ANSWERED), config);

    // Most exchanges contain no durable fact. An empty `memory_written` would
    // make the panel claim a write that did not happen.
    expect(emitted).toEqual([]);
    expect(update).toEqual({});
  });

  it('skips an abstention entirely', async () => {
    const { memory, exchanges } = stubMemory({ stored: [fact(1)] });
    const { config } = graphConfig();

    await new RememberNode(memory).run(
      state({
        text: 'I could not find this in the available sources.',
        citations: [],
        abstained: true,
      }),
      config,
    );

    // An abstention says something about the corpus, not about the person
    // asking — and it would cost a model call to learn that.
    expect(exchanges).toEqual([]);
  });

  it('skips a run that produced no answer at all', async () => {
    const { memory, exchanges } = stubMemory({ stored: [fact(1)] });
    const { config } = graphConfig();

    await new RememberNode(memory).run(state(null), config);
    expect(exchanges).toEqual([]);
  });

  it('skips extraction once the run budget is spent', async () => {
    const controller = new AbortController();
    controller.abort();
    const { memory, exchanges } = stubMemory({ stored: [fact(1)] });
    const { config } = graphConfig(controller.signal);

    await new RememberNode(memory).run(state(ANSWERED), config);

    // The caller has hung up or the wall-clock budget is gone. The answer is
    // already delivered; a model call here could only fail.
    expect(exchanges).toEqual([]);
  });
});

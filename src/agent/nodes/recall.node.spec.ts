import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { ChatResult, LlmService } from '../../ai/llm/llm.types';
import { AGENT_RUN_CONTEXT, type AgentRunContext } from '../agent-run-context';
import type { LongTermMemoryService } from '../../memory/long-term-memory.service';
import type { MemoryFact } from '../../memory/memory.types';
import type { EmittedAgentEvent } from '../events';
import type { SessionTurn } from '../agent.types';
import type { AgentState } from '../state';
import { RecallNode } from './recall.node';

function stubLlm(payload: object | string): { llm: LlmService; prompts: string[] } {
  const prompts: string[] = [];
  const llm: LlmService = {
    chat: (messages) => {
      prompts.push(messages.map((message) => message.content).join('\n'));
      const result: ChatResult = {
        text: typeof payload === 'string' ? payload : JSON.stringify(payload),
        provider: 'gemini',
        model: 'stub',
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 0,
        costUsd: null,
      };
      return Promise.resolve(result);
    },
  };
  return { llm, prompts };
}

function graphConfig(): { config: LangGraphRunnableConfig; emitted: EmittedAgentEvent[] } {
  const emitted: EmittedAgentEvent[] = [];
  const context: AgentRunContext = {
    runId: 'run-2',
    sessionId: 'session-1',
    sink: (event) => emitted.push(event),
    signal: new AbortController().signal,
    counter: { seq: 0 },
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    models: [],
    spans: [],
    rootSpanId: 'span-root',
    activeNodeSpanId: null,
  };
  return { config: { configurable: { [AGENT_RUN_CONTEXT]: context } }, emitted };
}

function fact(id: number, text: string): MemoryFact {
  return {
    id,
    text,
    kind: 'preference',
    importance: 0.8,
    accessCount: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    lastUsedAt: null,
    sourceRunId: 'run-0',
    sourceSessionId: 'session-0',
  };
}

/** Records what long-term memory was asked for, which is half of what matters here. */
function stubMemory(facts: MemoryFact[] = []): {
  memory: LongTermMemoryService;
  queries: string[];
} {
  const queries: string[] = [];
  const memory = {
    recall: (question: string) => {
      queries.push(question);
      return Promise.resolve(facts);
    },
  } as unknown as LongTermMemoryService;
  return { memory, queries };
}

const EARLIER_TURN: SessionTurn = {
  question: 'Why did the Helios launch slip?',
  answer: 'The billing migration failed load testing at 4x expected volume [1].',
  abstained: false,
  at: '2026-09-05T10:00:00.000Z',
};

function state(question: string, turns: SessionTurn[]): AgentState {
  return {
    question,
    askedQuestion: question,
    sessionId: 'session-1',
    runId: 'run-2',
    complexity: 'complex',
    subQuestions: [],
    evidence: [],
    memoryUsed: [],
    hops: 0,
    answer: null,
    events: [],
    turns,
  };
}

describe('RecallNode', () => {
  it('does not call a model on the first turn of a session', async () => {
    const { llm, prompts } = stubLlm({ standalone: 'anything', isFollowUp: true });
    const { config, emitted } = graphConfig();

    const update = await new RecallNode(llm, stubMemory().memory).run(
      state('Who approved it?', []),
      config,
    );

    // The common path. An empty history can only echo the question back, so a call
    // here would be latency and quota spent to learn nothing — and on a free tier
    // measured in tens of requests per minute, one wasted call per run matters.
    expect(prompts).toHaveLength(0);
    expect(emitted).toHaveLength(0);
    expect(update).toEqual({});
  });

  it('resolves a pronoun against the session and announces the rewrite', async () => {
    const { llm, prompts } = stubLlm({
      standalone: 'Who approved the new Helios launch date?',
      isFollowUp: true,
    });
    const { config, emitted } = graphConfig();

    const update = await new RecallNode(llm, stubMemory().memory).run(
      state('Who approved it?', [EARLIER_TURN]),
      config,
    );

    expect(update.question).toBe('Who approved the new Helios launch date?');
    // The earlier turn has to actually reach the prompt, or the model is resolving
    // the pronoun out of its own imagination.
    expect(prompts[0]).toContain('Why did the Helios launch slip?');

    const types = emitted.map((event) => event.type);
    expect(types).toEqual(['memory_read', 'followup_resolved']);

    const resolved = emitted.find((event) => event.type === 'followup_resolved');
    expect(resolved).toMatchObject({
      original: 'Who approved it?',
      resolved: 'Who approved the new Helios launch date?',
    });
  });

  it('leaves a standalone question alone and emits no rewrite', async () => {
    const { llm } = stubLlm({ standalone: 'When did Tariq Hassan start?', isFollowUp: false });
    const { config, emitted } = graphConfig();

    const update = await new RecallNode(llm, stubMemory().memory).run(
      state('When did Tariq Hassan start?', [EARLIER_TURN]),
      config,
    );

    // `question` is deliberately absent rather than set to the same string: the
    // absence of `followup_resolved` is what tells a consumer nothing was
    // reinterpreted, and it has to stay trustworthy.
    expect(update.question).toBeUndefined();
    expect(emitted.map((event) => event.type)).toEqual(['memory_read']);
  });

  it('reads the session even when the question needed no resolving', async () => {
    const { llm } = stubLlm({ standalone: '', isFollowUp: false });
    const { config, emitted } = graphConfig();

    const update = await new RecallNode(llm, stubMemory().memory).run(
      state('Something unrelated entirely', [EARLIER_TURN]),
      config,
    );

    const read = emitted.find((event) => event.type === 'memory_read');
    expect(read?.refs).toHaveLength(1);
    expect(read?.refs[0].kind).toBe('session_turn');
    expect(update.memoryUsed).toHaveLength(1);
  });

  it('falls back to the question as asked when the response is unparseable', async () => {
    const { llm } = stubLlm('the model said something conversational');
    const { config, emitted } = graphConfig();

    const update = await new RecallNode(llm, stubMemory().memory).run(
      state('Who approved it?', [EARLIER_TURN]),
      config,
    );

    // Unlike an unparseable plan there is a correct fallback: the literal
    // question. A worse answer beats a failed run.
    expect(update.question).toBeUndefined();
    expect(emitted.map((event) => event.type)).toEqual(['memory_read']);
  });

  it('recalls long-term facts alongside the session, tagged by kind', async () => {
    const { llm } = stubLlm({ standalone: '', isFollowUp: false });
    const { memory } = stubMemory([fact(4, 'The user works on the Helios project.')]);
    const { config, emitted } = graphConfig();

    const update = await new RecallNode(llm, memory).run(state('Did it ship?', []), config);

    const read = emitted.find((event) => event.type === 'memory_read');
    expect(read?.refs).toEqual([
      { id: 'fact-4', kind: 'preference', text: 'The user works on the Helios project.' },
    ]);
    // Downstream nodes read facts off `memoryUsed`, and tell them apart from
    // session turns by kind — see `rememberedFacts`.
    expect(update.memoryUsed).toHaveLength(1);
  });

  it('searches long-term memory with the resolved question, not the pronoun', async () => {
    const { llm } = stubLlm({
      standalone: 'Who approved the new Helios launch date?',
      isFollowUp: true,
    });
    const { memory, queries } = stubMemory();
    const { config } = graphConfig();

    await new RecallNode(llm, memory).run(state('Who approved it?', [EARLIER_TURN]), config);

    // Embedding "Who approved it?" matches nothing: the pronoun carries no
    // meaning for a vector search. Resolution has to happen first.
    expect(queries).toEqual(['Who approved the new Helios launch date?']);
  });

  it('answers without memory when the long-term store is unreachable', async () => {
    const { llm } = stubLlm({ standalone: '', isFollowUp: false });
    const failing = {
      recall: () => Promise.reject(new Error('embedding provider down')),
    } as unknown as LongTermMemoryService;
    const { config, emitted } = graphConfig();

    const update = await new RecallNode(llm, failing).run(
      state('Did it ship?', [EARLIER_TURN]),
      config,
    );

    // The session's own turns still got through, and the run continues.
    expect(update.memoryUsed).toHaveLength(1);
    expect(emitted.map((event) => event.type)).toEqual(['memory_read']);
  });

  it('discards a rewrite shorter than the question it replaces', async () => {
    const { llm } = stubLlm({ standalone: 'Who approved?', isFollowUp: true });
    const { config } = graphConfig();

    const update = await new RecallNode(llm, stubMemory().memory).run(
      state('Who approved it, and when did they sign it off?', [EARLIER_TURN]),
      config,
    );

    // Substituting a referent can only lengthen a question. A shorter result is
    // the model summarising, which silently narrows what the run goes looking for.
    expect(update.question).toBeUndefined();
  });
});

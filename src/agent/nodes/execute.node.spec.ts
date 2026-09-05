import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { RetrievedChunk } from '../../rag/retrieved-chunk.type';
import type { Evidence, SubQuestion } from '../agent.types';
import { AGENT_RUN_CONTEXT, type AgentRunContext } from '../agent-run-context';
import type { EmittedAgentEvent } from '../events';
import type { AgentState } from '../state';
import type { AgentTool } from '../tools/agent-tool';
import { ToolRegistry } from '../tools/tool-registry';
import { ExecuteNode } from './execute.node';

interface CallLog {
  tool: string;
  startedAt: number;
  finishedAt: number;
}

function chunk(chunkId: number): RetrievedChunk {
  return {
    chunkId,
    articleId: 1,
    articleTitle: `Article ${chunkId}`,
    text: `text ${chunkId}`,
    distance: 0.2,
    source: 'mail',
    docId: `doc-${chunkId}`,
  };
}

/** A tool that takes measurable time, so overlap is observable. */
function timedTool(name: string, delayMs: number, log: CallLog[], chunkId: number): AgentTool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    async execute(): Promise<RetrievedChunk[]> {
      const startedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const finishedAt = Date.now();
      log.push({ tool: name, startedAt, finishedAt });
      return [chunk(chunkId)];
    },
  };
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
  };
  return { config: { configurable: { [AGENT_RUN_CONTEXT]: context } }, emitted };
}

function state(subQuestions: SubQuestion[]): AgentState {
  return {
    question: 'q',
    sessionId: 'session-1',
    runId: 'run-1',
    complexity: 'complex',
    subQuestions,
    evidence: [],
    memoryUsed: [],
    hops: 0,
    answer: null,
    events: [],
  };
}

describe('ExecuteNode', () => {
  it('runs independent sub-questions concurrently', async () => {
    const log: CallLog[] = [];
    const registry = new ToolRegistry([
      timedTool('mail_search', 50, log, 1),
      timedTool('chat_search', 50, log, 2),
    ]);
    const { config } = graphConfig();

    const started = Date.now();
    await new ExecuteNode(registry).run(
      state([
        { id: 'sq1', text: 'a', tool: 'mail_search', status: 'pending', hop: 0 },
        { id: 'sq2', text: 'b', tool: 'chat_search', status: 'pending', hop: 0 },
      ]),
      config,
    );
    const elapsed = Date.now() - started;

    expect(log).toHaveLength(2);
    // Sequential execution would take at least 100ms; overlap keeps it near 50ms.
    expect(elapsed).toBeLessThan(95);
    const [first, second] = log;
    expect(Math.min(first.finishedAt, second.finishedAt)).toBeGreaterThanOrEqual(
      Math.max(first.startedAt, second.startedAt),
    );
  });

  it('defers a dependent sub-question until its dependency has finished', async () => {
    const log: CallLog[] = [];
    const registry = new ToolRegistry([
      timedTool('mail_search', 30, log, 1),
      timedTool('chat_search', 10, log, 2),
    ]);

    await new ExecuteNode(registry).run(
      state([
        { id: 'sq1', text: 'a', tool: 'mail_search', status: 'pending', hop: 0 },
        {
          id: 'sq2',
          text: 'b',
          tool: 'chat_search',
          status: 'pending',
          hop: 0,
          dependsOn: ['sq1'],
        },
      ]),
      graphConfig().config,
    );

    expect(log.map((entry) => entry.tool)).toEqual(['mail_search', 'chat_search']);
    expect(log[1].startedAt).toBeGreaterThanOrEqual(log[0].finishedAt);
  });

  it('mints stable evidence ids and reports them on tool_finished', async () => {
    const registry = new ToolRegistry([timedTool('mail_search', 1, [], 7)]);
    const { config, emitted } = graphConfig();

    const update = await new ExecuteNode(registry).run(
      state([{ id: 'sq1', text: 'a', tool: 'mail_search', status: 'pending', hop: 0 }]),
      config,
    );

    const evidence = update.evidence as Evidence[];
    expect(evidence[0].evidenceId).toBe('ev-7');
    expect(evidence[0].retrievedBy).toBe('sq1');
    expect(emitted.map((e) => e.type)).toEqual(['tool_started', 'tool_finished', 'evidence_added']);
  });

  it('leaves already-completed sub-questions alone so a second hop only runs follow-ups', async () => {
    const log: CallLog[] = [];
    const registry = new ToolRegistry([timedTool('mail_search', 1, log, 1)]);

    await new ExecuteNode(registry).run(
      state([
        { id: 'sq1', text: 'a', tool: 'mail_search', status: 'done', hop: 0 },
        { id: 'sq2', text: 'b', tool: 'mail_search', status: 'pending', hop: 1 },
      ]),
      graphConfig().config,
    );

    expect(log).toHaveLength(1);
  });

  it('marks a sub-question failed without sinking the run when its tool throws', async () => {
    const registry = new ToolRegistry([
      {
        name: 'mail_search',
        description: 'mail',
        inputSchema: { type: 'object' },
        execute: () => Promise.reject(new Error('index unavailable')),
      },
      timedTool('chat_search', 1, [], 2),
    ]);

    const { config, emitted } = graphConfig();
    const update = await new ExecuteNode(registry).run(
      state([
        { id: 'sq1', text: 'a', tool: 'mail_search', status: 'pending', hop: 0 },
        { id: 'sq2', text: 'b', tool: 'chat_search', status: 'pending', hop: 0 },
      ]),
      config,
    );

    const subQuestions = update.subQuestions as SubQuestion[];
    const bySubQuestion = new Map(subQuestions.map((sq) => [sq.id, sq]));
    expect(bySubQuestion.get('sq1')?.status).toBe('failed');
    expect(bySubQuestion.get('sq1')?.error).toBe('index unavailable');
    expect(bySubQuestion.get('sq2')?.status).toBe('done');
    expect(update.evidence).toHaveLength(1);

    // `status: 'failed'` only ever reaches graph state, so without `error` on the
    // event a consumer cannot tell this apart from a search that found nothing —
    // and the UI rendered it as a completed sub-question.
    const finished = emitted.filter((event) => event.type === 'tool_finished');
    const failed = finished.find((event) => event.subQuestionId === 'sq1');
    expect(failed?.error).toBe('index unavailable');
    expect(failed?.evidenceIds).toEqual([]);
    expect(finished.find((event) => event.subQuestionId === 'sq2')?.error).toBeUndefined();
  });

  // Without a `tool_finished` here the sub-question `reflect` announced would sit
  // pending in a consumer for the rest of the run — nothing else ever mentions it.
  it('announces an unknown tool as a failed call rather than saying nothing', async () => {
    const { config, emitted } = graphConfig();

    const update = await new ExecuteNode(
      new ToolRegistry([timedTool('mail_search', 1, [], 1)]),
    ).run(
      state([{ id: 'sq1', text: 'a', tool: 'nope_search', status: 'pending', hop: 1 }]),
      config,
    );

    expect((update.subQuestions as SubQuestion[])[0].status).toBe('failed');

    const finished = emitted.find((event) => event.type === 'tool_finished');
    expect(finished?.subQuestionId).toBe('sq1');
    expect(finished?.error).toContain('nope_search');
  });

  it('fails pending sub-questions instead of hanging once the run budget is spent', async () => {
    const log: CallLog[] = [];
    const registry = new ToolRegistry([timedTool('mail_search', 1, log, 1)]);
    const controller = new AbortController();
    controller.abort();

    const update = await new ExecuteNode(registry).run(
      state([{ id: 'sq1', text: 'a', tool: 'mail_search', status: 'pending', hop: 0 }]),
      graphConfig(controller.signal).config,
    );

    expect(log).toHaveLength(0);
    expect((update.subQuestions as SubQuestion[])[0].status).toBe('failed');
  });
});

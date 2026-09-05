import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { ChatResult, LlmService } from '../../ai/llm/llm.types';
import type { AppConfigService } from '../../config/app-config.service';
import type { RetrievedChunk } from '../../rag/retrieved-chunk.type';
import type { SubQuestion } from '../agent.types';
import { AGENT_RUN_CONTEXT, type AgentRunContext } from '../agent-run-context';
import type { AgentState } from '../state';
import type { AgentTool } from '../tools/agent-tool';
import { ToolRegistry } from '../tools/tool-registry';
import { ReflectNode } from './reflect.node';

function stubTool(name: string): AgentTool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    execute: (): Promise<RetrievedChunk[]> => Promise.resolve([]),
  };
}

function stubLlm(payload: unknown): LlmService {
  return {
    chat: (): Promise<ChatResult> =>
      Promise.resolve({
        text: JSON.stringify(payload),
        provider: 'gemini',
        model: 'stub',
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 0,
        costUsd: null,
      }),
  };
}

function graphConfig(): LangGraphRunnableConfig {
  const context: AgentRunContext = {
    runId: 'run-1',
    sessionId: 'session-1',
    sink: () => undefined,
    signal: new AbortController().signal,
    counter: { seq: 0 },
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    models: [],
    spans: [],
    rootSpanId: 'span-root',
    activeNodeSpanId: null,
  };
  return { configurable: { [AGENT_RUN_CONTEXT]: context } };
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

const config = { maxHops: 2, maxFanOut: 5 } as unknown as AppConfigService;

describe('ReflectNode', () => {
  const registry = new ToolRegistry([stubTool('mail_search'), stubTool('all_sources_search')]);

  /**
   * Regression: follow-up ids were derived from `subQuestions.length`, which
   * assumes a dense sq1..sqN. The planner preserves whatever ids the model
   * returned, so a sparse plan collided — and because state merges by id, the
   * follow-up overwrote a *completed* sub-question, flipping it back to pending.
   */
  it('does not reuse the id of an existing sub-question when a plan is sparse', async () => {
    const llm = stubLlm({
      gapFound: true,
      reasoning: 'need the owner',
      followUps: [{ text: 'Who owns it?', tool: 'mail_search' }],
    });
    // Length 2, but ids are sq1 and sq3 — length+1 would mint "sq3" again.
    const existing: SubQuestion[] = [
      { id: 'sq1', text: 'a', tool: 'mail_search', status: 'done', hop: 0 },
      { id: 'sq3', text: 'b', tool: 'mail_search', status: 'done', hop: 0 },
    ];

    const update = await new ReflectNode(llm, registry, config).run(state(existing), graphConfig());

    const followUps = update.subQuestions as SubQuestion[];
    expect(followUps).toHaveLength(1);
    expect(followUps[0].id).not.toBe('sq3');
    expect(existing.map((sq) => sq.id)).not.toContain(followUps[0].id);
    expect(followUps[0].hop).toBe(1);
  });

  it('reports no gap once the hop budget is spent, without calling the model', async () => {
    const llm: LlmService = {
      chat: () => Promise.reject(new Error('reflect must not call the model past MAX_HOPS')),
    };
    const spent = { ...state([]), hops: 2 };

    const update = await new ReflectNode(llm, registry, config).run(spent, graphConfig());

    expect(update.hops).toBe(3);
    expect(update.subQuestions ?? []).toHaveLength(0);
  });

  it('treats a claimed gap with no usable follow-up as no gap', async () => {
    const llm = stubLlm({ gapFound: true, reasoning: 'vague', followUps: [] });

    const update = await new ReflectNode(llm, registry, config).run(state([]), graphConfig());

    expect(update.subQuestions ?? []).toHaveLength(0);
  });

  it('substitutes the default tool when reflection invents a tool name', async () => {
    const llm = stubLlm({
      gapFound: true,
      reasoning: 'need more',
      followUps: [{ text: 'Where?', tool: 'jira_search' }],
    });

    const update = await new ReflectNode(llm, registry, config).run(state([]), graphConfig());

    expect((update.subQuestions as SubQuestion[])[0].tool).toBe('all_sources_search');
  });
});

import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { ChatResult, LlmService } from '../../ai/llm/llm.types';
import type { AppConfigService } from '../../config/app-config.service';
import type { RetrievedChunk } from '../../rag/retrieved-chunk.type';
import { AGENT_RUN_CONTEXT, type AgentRunContext } from '../agent-run-context';
import type { AgentEvent, EmittedAgentEvent } from '../events';
import type { SubQuestion } from '../agent.types';
import type { AgentState } from '../state';
import type { AgentTool } from '../tools/agent-tool';
import { ToolRegistry } from '../tools/tool-registry';
import { PlanNode } from './plan.node';

function stubTool(name: string): AgentTool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object' },
    execute: (): Promise<RetrievedChunk[]> => Promise.resolve([]),
  };
}

function stubLlm(text: string): { llm: LlmService; prompts: string[] } {
  const prompts: string[] = [];
  const llm: LlmService = {
    chat: (messages, options) => {
      prompts.push(options?.system ?? '');
      const result: ChatResult = {
        text,
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

function stubConfig(maxFanOut: number): AppConfigService {
  return { maxFanOut, maxHops: 2 } as unknown as AppConfigService;
}

function graphConfig(): { config: LangGraphRunnableConfig; emitted: EmittedAgentEvent[] } {
  const emitted: EmittedAgentEvent[] = [];
  const context: AgentRunContext = {
    runId: 'run-1',
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

function state(question: string): AgentState {
  return {
    question,
    sessionId: 'session-1',
    runId: 'run-1',
    complexity: 'complex',
    subQuestions: [],
    evidence: [],
    memoryUsed: [],
    hops: 0,
    answer: null,
    events: [],
  };
}

describe('PlanNode', () => {
  const registry = new ToolRegistry([
    stubTool('mail_search'),
    stubTool('chat_search'),
    stubTool('all_sources_search'),
  ]);

  it('turns structured output into runnable sub-questions', async () => {
    const { llm } = stubLlm(
      JSON.stringify({
        subQuestions: [
          { id: 'sq1', text: 'When did Helios slip?', tool: 'mail_search', dependsOn: [] },
          { id: 'sq2', text: 'Who raised the concern?', tool: 'chat_search', dependsOn: ['sq1'] },
        ],
      }),
    );
    const { config, emitted } = graphConfig();

    const update = await new PlanNode(llm, registry, stubConfig(5)).run(
      state('Why did Helios slip?'),
      config,
    );

    expect(update.subQuestions).toEqual([
      {
        id: 'sq1',
        text: 'When did Helios slip?',
        tool: 'mail_search',
        status: 'pending',
        hop: 0,
      },
      {
        id: 'sq2',
        text: 'Who raised the concern?',
        tool: 'chat_search',
        status: 'pending',
        hop: 0,
        dependsOn: ['sq1'],
      },
    ]);
    expect(emitted.map((e) => e.type)).toEqual(['plan_created']);
  });

  it('offers the planner the live tool registry rather than a hardcoded list', async () => {
    const { llm, prompts } = stubLlm(JSON.stringify({ subQuestions: [] }));

    await new PlanNode(llm, registry, stubConfig(5)).run(state('q'), graphConfig().config);

    expect(prompts[0]).toContain('mail_search: mail_search description');
    expect(prompts[0]).toContain('all_sources_search: all_sources_search description');
  });

  it('substitutes the default tool when the planner invents a tool name', async () => {
    const { llm } = stubLlm(
      JSON.stringify({
        subQuestions: [{ id: 'sq1', text: 'anything', tool: 'jira_search', dependsOn: [] }],
      }),
    );

    const update = await new PlanNode(llm, registry, stubConfig(5)).run(
      state('q'),
      graphConfig().config,
    );

    expect((update.subQuestions as SubQuestion[])[0].tool).toBe('all_sources_search');
  });

  it('drops dependsOn ids that were never planned, which would deadlock execute', async () => {
    const { llm } = stubLlm(
      JSON.stringify({
        subQuestions: [{ id: 'sq1', text: 'anything', tool: 'mail_search', dependsOn: ['sq9'] }],
      }),
    );

    const update = await new PlanNode(llm, registry, stubConfig(5)).run(
      state('q'),
      graphConfig().config,
    );

    expect((update.subQuestions as SubQuestion[])[0].dependsOn).toBeUndefined();
  });

  it('caps fan-out at MAX_FAN_OUT', async () => {
    const { llm } = stubLlm(
      JSON.stringify({
        subQuestions: Array.from({ length: 8 }, (_, i) => ({
          id: `sq${i + 1}`,
          text: `q${i + 1}`,
          tool: 'mail_search',
          dependsOn: [],
        })),
      }),
    );

    const update = await new PlanNode(llm, registry, stubConfig(3)).run(
      state('q'),
      graphConfig().config,
    );

    expect(update.subQuestions).toHaveLength(3);
  });

  it('falls back to one broad search when the response is unparseable', async () => {
    const { llm } = stubLlm('I am afraid I cannot do that.');

    const update = await new PlanNode(llm, registry, stubConfig(5)).run(
      state('Why did Helios slip?'),
      graphConfig().config,
    );

    expect(update.subQuestions).toEqual([
      {
        id: 'sq1',
        text: 'Why did Helios slip?',
        tool: 'all_sources_search',
        status: 'pending',
        hop: 0,
      },
    ]);
  });

  // Two sub-questions sharing an id collapse in the merge-by-id state reducer, so
  // the plan would advertise work that never runs.
  it('renames a duplicate sub-question id so both survive the state reducer', async () => {
    const { llm } = stubLlm(
      JSON.stringify({
        subQuestions: [
          { id: 'sq1', text: 'first', tool: 'mail_search', dependsOn: [] },
          { id: 'sq1', text: 'second', tool: 'chat_search', dependsOn: [] },
        ],
      }),
    );

    const update = await new PlanNode(llm, registry, stubConfig(5)).run(
      state('q'),
      graphConfig().config,
    );

    const subQuestions = update.subQuestions as SubQuestion[];
    expect(subQuestions).toHaveLength(2);
    expect(new Set(subQuestions.map((sq) => sq.id)).size).toBe(2);
    expect(subQuestions.map((sq) => sq.text)).toEqual(['first', 'second']);
  });

  it('records token usage against the run', async () => {
    const { llm } = stubLlm(JSON.stringify({ subQuestions: [] }));
    const { config } = graphConfig();

    await new PlanNode(llm, registry, stubConfig(5)).run(state('q'), config);

    const context = config.configurable?.[AGENT_RUN_CONTEXT] as AgentRunContext;
    expect(context.usage.inputTokens).toBe(1);
  });

  it('emits the plan into state for replay as well as to the live sink', async () => {
    const { llm } = stubLlm(
      JSON.stringify({
        subQuestions: [{ id: 'sq1', text: 'q', tool: 'mail_search', dependsOn: [] }],
      }),
    );

    const update = await new PlanNode(llm, registry, stubConfig(5)).run(
      state('q'),
      graphConfig().config,
    );

    const events = update.events as AgentEvent[];
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('plan_created');
  });
});

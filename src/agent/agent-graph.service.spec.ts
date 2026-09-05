import type { ChatOptions, ChatResult, LlmService } from '../ai/llm/llm.types';
import type { AppConfigService } from '../config/app-config.service';
import type { RetrievedChunk } from '../rag/retrieved-chunk.type';
import { AgentGraphService } from './agent-graph.service';
import type { AgentEventType } from './events';
import { ExecuteNode } from './nodes/execute.node';
import { PlanNode } from './nodes/plan.node';
import { ReflectNode } from './nodes/reflect.node';
import { SynthesizeNode } from './nodes/synthesize.node';
import { TriageNode } from './nodes/triage.node';
import type { AgentTool } from './tools/agent-tool';
import { ToolRegistry } from './tools/tool-registry';

interface Script {
  triage: object;
  plan: object;
  reflect: object[];
  synthesis: object;
}

/**
 * Routes each node's call by the system prompt it sends, so one stub can play
 * every model in the graph without the nodes knowing they are being tested.
 */
function scriptedLlm(script: Script): LlmService {
  let reflectCalls = 0;

  return {
    chat(_messages, options?: ChatOptions): Promise<ChatResult> {
      const system = options?.system ?? '';
      let payload: object;

      if (system.startsWith('You triage questions')) {
        payload = script.triage;
      } else if (system.startsWith('You plan retrieval')) {
        payload = script.plan;
      } else if (system.startsWith('You review whether')) {
        payload = script.reflect[Math.min(reflectCalls++, script.reflect.length - 1)];
      } else if (system.startsWith('You answer questions using only')) {
        payload = script.synthesis;
      } else {
        throw new Error(`Unscripted model call: ${system.slice(0, 40)}`);
      }

      return Promise.resolve({
        text: JSON.stringify(payload),
        provider: 'gemini',
        model: 'stub',
        usage: { inputTokens: 10, outputTokens: 5 },
        latencyMs: 0,
        costUsd: null,
      });
    },
  };
}

function tool(name: string, chunkIds: number[]): AgentTool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    execute: (): Promise<RetrievedChunk[]> =>
      Promise.resolve(
        chunkIds.map((chunkId) => ({
          chunkId,
          articleId: chunkId,
          articleTitle: `Article ${chunkId}`,
          text: `Passage ${chunkId}`,
          distance: 0.1 * chunkId,
          source: 'mail' as const,
          docId: `doc-${chunkId}`,
        })),
      ),
  };
}

function buildGraph(script: Script, overrides: Partial<AppConfigService> = {}): AgentGraphService {
  const llm = scriptedLlm(script);
  const registry = new ToolRegistry([
    tool('mail_search', [1, 2]),
    tool('chat_search', [3]),
    tool('notes_search', [4]),
    tool('all_sources_search', [1, 3]),
  ]);
  const config = {
    maxHops: 2,
    maxFanOut: 5,
    agentTimeoutMs: 10_000,
    ...overrides,
  } as unknown as AppConfigService;

  return new AgentGraphService(
    config,
    new TriageNode(llm, registry),
    new PlanNode(llm, registry, config),
    new ExecuteNode(registry),
    new ReflectNode(llm, registry, config),
    new SynthesizeNode(llm),
  );
}

const NO_GAP = { gapFound: false, reasoning: 'covered', followUps: [] };

describe('AgentGraphService', () => {
  it('routes a simple question straight to retrieval, skipping the planner', async () => {
    const graph = buildGraph({
      triage: { complexity: 'simple', reasoning: 'one fact' },
      plan: { subQuestions: [] },
      reflect: [NO_GAP],
      synthesis: { answer: 'The date was 25 February [1].', abstained: false },
    });

    const result = await graph.run({ question: 'When did Helios ship?' });
    const types = result.events.map((e) => e.type);

    expect(result.state.complexity).toBe('simple');
    expect(types).not.toContain<AgentEventType>('plan_created');
    expect(types).toContain<AgentEventType>('tool_started');
    expect(types[0]).toBe('run_started');
    expect(types[types.length - 1]).toBe('run_finished');
  });

  it('plans and fans out across distinct sources for a complex question', async () => {
    const graph = buildGraph({
      triage: { complexity: 'complex', reasoning: 'needs two sources' },
      plan: {
        subQuestions: [
          { id: 'sq1', text: 'What slipped?', tool: 'mail_search', dependsOn: [] },
          { id: 'sq2', text: 'Who flagged it?', tool: 'chat_search', dependsOn: [] },
        ],
      },
      reflect: [NO_GAP],
      synthesis: {
        answer: 'Helios slipped [1] after Priya flagged the risk [3].',
        abstained: false,
      },
    });

    const result = await graph.run({ question: 'Why did Helios slip and who flagged it?' });

    const planCreated = result.events.find((e) => e.type === 'plan_created');
    expect(planCreated).toBeDefined();
    expect(planCreated?.type === 'plan_created' && planCreated.subQuestions.length).toBe(2);

    const toolsUsed = new Set(
      result.events.filter((e) => e.type === 'tool_started').map((e) => e.tool),
    );
    expect(toolsUsed.size).toBeGreaterThanOrEqual(2);
  });

  it('takes a second hop when reflection finds a gap', async () => {
    const graph = buildGraph({
      triage: { complexity: 'complex', reasoning: 'needs two sources' },
      plan: {
        subQuestions: [{ id: 'sq1', text: 'What slipped?', tool: 'mail_search', dependsOn: [] }],
      },
      reflect: [
        {
          gapFound: true,
          reasoning: 'no owner identified',
          followUps: [{ text: 'Who owns Helios?', tool: 'notes_search' }],
        },
        NO_GAP,
      ],
      synthesis: { answer: 'Helios slipped [1]; Dana owns it [3].', abstained: false },
    });

    const result = await graph.run({ question: 'Why did Helios slip and who owns it?' });

    const reflections = result.events.filter((e) => e.type === 'reflect_done');
    expect(reflections[0].type === 'reflect_done' && reflections[0].gapFound).toBe(true);
    expect(result.state.hops).toBe(2);

    const followUp = result.state.subQuestions.find((sq) => sq.hop === 1);
    expect(followUp?.tool).toBe('notes_search');
    expect(followUp?.status).toBe('done');
  });

  it('stops at MAX_HOPS even when reflection keeps claiming a gap', async () => {
    const insistentGap = {
      gapFound: true,
      reasoning: 'still missing something',
      followUps: [{ text: 'One more thing?', tool: 'notes_search' }],
    };
    const graph = buildGraph(
      {
        triage: { complexity: 'complex', reasoning: 'complex' },
        plan: {
          subQuestions: [{ id: 'sq1', text: 'What slipped?', tool: 'mail_search', dependsOn: [] }],
        },
        reflect: [insistentGap],
        synthesis: { answer: 'Partial answer [1].', abstained: false },
      },
      { maxHops: 1 },
    );

    const result = await graph.run({ question: 'q' });

    expect(result.state.hops).toBeLessThanOrEqual(2);
    expect(result.answer.text).toContain('Partial answer');
  });

  // The M1 acceptance criterion, asserted programmatically: a citation the model
  // emitted must resolve to evidence that is actually in state.
  it('resolves every citation in the final answer to evidence present in state', async () => {
    const graph = buildGraph({
      triage: { complexity: 'complex', reasoning: 'complex' },
      plan: {
        subQuestions: [
          { id: 'sq1', text: 'a', tool: 'mail_search', dependsOn: [] },
          { id: 'sq2', text: 'b', tool: 'chat_search', dependsOn: [] },
        ],
      },
      reflect: [NO_GAP],
      synthesis: { answer: 'First [1]. Second [2]. Third [3].', abstained: false },
    });

    const result = await graph.run({ question: 'q' });
    const knownIds = new Set(result.state.evidence.map((e) => e.evidenceId));

    expect(result.answer.citations.length).toBeGreaterThan(0);
    for (const citation of result.answer.citations) {
      expect(knownIds).toContain(citation.evidenceId);
    }
  });

  it('drops a fabricated citation rather than emitting a dead link', async () => {
    const graph = buildGraph({
      triage: { complexity: 'simple', reasoning: 'one fact' },
      plan: { subQuestions: [] },
      reflect: [NO_GAP],
      synthesis: { answer: 'Real [1]. Invented [99].', abstained: false },
    });

    const result = await graph.run({ question: 'q' });

    expect(result.answer.citations.map((c) => c.marker)).toEqual([1]);
    expect(result.answer.text).not.toContain('[99]');
  });

  it('carries an abstention through to the answer', async () => {
    const graph = buildGraph({
      triage: { complexity: 'simple', reasoning: 'one fact' },
      plan: { subQuestions: [] },
      reflect: [NO_GAP],
      synthesis: {
        answer: 'I could not find this in the available sources.',
        abstained: true,
      },
    });

    const result = await graph.run({ question: 'What is the CEO home address?' });

    expect(result.answer.abstained).toBe(true);
    expect(result.answer.citations).toEqual([]);
  });

  it('reports aggregated usage and a monotonic event sequence', async () => {
    const graph = buildGraph({
      triage: { complexity: 'simple', reasoning: 'one fact' },
      plan: { subQuestions: [] },
      reflect: [NO_GAP],
      synthesis: { answer: 'Answer [1].', abstained: false },
    });

    const streamed: AgentEventType[] = [];
    const result = await graph.run({
      question: 'q',
      sink: (event) => streamed.push(event.type),
    });

    // triage + reflect + synthesis, at 10 input tokens each.
    expect(result.usage.inputTokens).toBe(30);
    expect(streamed).toEqual(result.events.map((e) => e.type));
    expect(result.events.map((e) => e.seq)).toEqual(result.events.map((_, i) => i));
  });
});

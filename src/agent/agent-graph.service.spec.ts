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
import { LangSmithTracing } from '../observability/langsmith-tracing.service';
import { TraceCollector } from '../observability/trace-collector.service';
import type { TraceRepository } from '../repositories/ports/trace.repository';
import type { PersistedRun, RunSpan } from '../common/types/trace.types';

/** Tracing off, so traceTool hands the retrieval function straight back. */
const noTracing = (): LangSmithTracing =>
  new LangSmithTracing({ langsmithTracing: false } as AppConfigService);

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

/**
 * Captures what the collector persisted instead of touching sqlite — the graph's
 * contract is "a finished run produces a trace", and which table it lands in is
 * the repository's business.
 */
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

function buildGraph(
  script: Script,
  overrides: Partial<AppConfigService> = {},
  traceRepo: TraceRepository = new FakeTraceRepository(),
): AgentGraphService {
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
    new ExecuteNode(registry, noTracing()),
    new ReflectNode(llm, registry, config),
    new SynthesizeNode(llm),
    new TraceCollector(traceRepo),
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
  describe('tracing', () => {
    const simpleScript = {
      triage: { complexity: 'simple', reasoning: 'one fact' },
      plan: { subQuestions: [] },
      reflect: [NO_GAP],
      synthesis: { answer: 'Answer [1].', abstained: false },
    };

    it('persists a trace whose spans nest node -> tool and node -> llm', async () => {
      // This is M3.1's acceptance criterion expressed locally: a trace is only
      // useful if the hierarchy survives, and the LLM level is the one that goes
      // missing, because model calls do not travel on the event stream at all.
      const repo = new FakeTraceRepository();
      const graph = buildGraph(simpleScript, {}, repo);

      const result = await graph.run({ question: 'When did Helios ship?' });
      const trace = await repo.get(result.runId);
      const spans = trace?.spans ?? [];
      const byId = new Map(spans.map((span) => [span.spanId, span]));

      const root = spans.find((span) => span.kind === 'run');
      expect(root?.parentSpanId).toBeNull();

      const nodeIds = new Set(
        spans.filter((span) => span.kind === 'node').map((span) => span.spanId),
      );
      expect(spans.filter((span) => span.kind === 'node').map((span) => span.name)).toEqual(
        expect.arrayContaining(['triage', 'execute', 'reflect', 'synthesize']),
      );

      const tools = spans.filter((span) => span.kind === 'tool');
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(byId.get(tool.parentSpanId ?? '')?.name).toBe('execute');
      }

      const llms = spans.filter((span) => span.kind === 'llm');
      expect(llms.length).toBe(3);
      for (const llm of llms) {
        expect(nodeIds.has(llm.parentSpanId ?? '')).toBe(true);
      }

      // Every span except the root hangs off something that exists.
      for (const span of spans) {
        if (span.kind === 'run') continue;
        expect(byId.has(span.parentSpanId ?? '')).toBe(true);
      }
    });

    it('records a node span per pass when reflection loops back into execute', async () => {
      const repo = new FakeTraceRepository();
      const graph = buildGraph(
        {
          triage: { complexity: 'complex', reasoning: 'two parts' },
          plan: {
            subQuestions: [
              { id: 'sq1', text: 'What slipped?', tool: 'mail_search', dependsOn: [] },
            ],
          },
          reflect: [
            {
              gapFound: true,
              reasoning: 'who approved it is missing',
              followUps: [
                { id: 'sq2', text: 'Who approved it?', tool: 'chat_search', dependsOn: [] },
              ],
            },
            NO_GAP,
          ],
          synthesis: { answer: 'Because [1], approved by [3].', abstained: false },
        },
        {},
        repo,
      );

      const result = await graph.run({ question: 'Why did it slip and who approved it?' });
      const spans = (await repo.get(result.runId))?.spans ?? [];

      const executes = spans.filter((span) => span.kind === 'node' && span.name === 'execute');
      expect(executes).toHaveLength(2);

      // The two passes must not overlap, or resolving a tool's parent by
      // containment would be ambiguous.
      const [first, second] = [...executes].sort(
        (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt),
      );
      expect(Date.parse(first.endedAt)).toBeLessThanOrEqual(Date.parse(second.startedAt));
    });

    it('persists a trace for a run that threw', async () => {
      const repo = new FakeTraceRepository();
      const exploding: LlmService = {
        chat: () => Promise.reject(new Error('quota exhausted')),
      };
      const registry = new ToolRegistry([tool('mail_search', [1])]);
      const config = { maxHops: 2, maxFanOut: 5, agentTimeoutMs: 10_000 } as AppConfigService;
      const graph = new AgentGraphService(
        config,
        new TriageNode(exploding, registry),
        new PlanNode(exploding, registry, config),
        new ExecuteNode(registry, noTracing()),
        new ReflectNode(exploding, registry, config),
        new SynthesizeNode(exploding),
        new TraceCollector(repo),
      );

      await expect(graph.run({ question: 'anything' })).rejects.toThrow('quota exhausted');

      // The in-memory store this replaced only ever saw runs that returned, so a
      // failed run left no record at all — the case most worth inspecting.
      expect(repo.saved).toHaveLength(1);
      expect(repo.saved[0].run).toMatchObject({ status: 'failed', answer: null });
      expect(repo.saved[0].run.error).toContain('quota exhausted');
    });

    it('leaves a run unpriced when any of its calls was unpriced', async () => {
      // The stub reports costUsd: null. One unpriced call has to poison the run
      // total, or the figure reads as authoritative while omitting a call.
      const repo = new FakeTraceRepository();
      const graph = buildGraph(simpleScript, {}, repo);

      const result = await graph.run({ question: 'q' });

      expect(result.costUsd).toBeNull();
      expect((await repo.get(result.runId))?.run.costUsd).toBeNull();
    });
  });
  describe('cancellation', () => {
    const script = {
      triage: { complexity: 'simple', reasoning: 'one fact' },
      plan: { subQuestions: [] },
      reflect: [NO_GAP],
      synthesis: { answer: 'Answer [1].', abstained: false },
    };

    it('retrieves nothing when the caller signal is already aborted', async () => {
      // The controller can hand over a signal that fired before `run()` was called.
      // Subscribing without checking `aborted` first means the listener never runs
      // and the run proceeds as if nobody cancelled — which is exactly how a client
      // disconnect went unnoticed until 2026-09-05.
      //
      // The graph drains rather than throwing, which is deliberate: an aborted run
      // still has to close its SSE stream tidily. So the assertion is that no
      // retrieval was *spent*, not that the promise rejected.
      const graph = buildGraph(script);

      const result = await graph.run({ question: 'q', signal: AbortSignal.abort() });

      expect(result.events.map((event) => event.type)).not.toContain<AgentEventType>(
        'tool_started',
      );
      expect(result.state.subQuestions.every((sq) => sq.status === 'failed')).toBe(true);
      expect(result.answer.abstained).toBe(true);
    });

    it('runs to completion when the caller signal never fires', async () => {
      // The other half of the guard: it must not make every run look cancelled.
      const graph = buildGraph(script);
      const controller = new AbortController();

      const result = await graph.run({ question: 'q', signal: controller.signal });

      // The other half of the guard: it must not make every run look cancelled.
      expect(result.events.map((event) => event.type)).toContain<AgentEventType>('tool_started');
      expect(result.answer.abstained).toBe(false);
      expect(result.events.at(-1)?.type).toBe('run_finished');
    });
  });
});

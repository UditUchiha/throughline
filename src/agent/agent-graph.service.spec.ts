import Database from 'better-sqlite3';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import type { ChatOptions, ChatResult, LlmService } from '../ai/llm/llm.types';
import type { AppConfigService } from '../config/app-config.service';
import type { RetrievedChunk } from '../rag/retrieved-chunk.type';
import { AgentGraphService } from './agent-graph.service';
import type { AgentEventType } from './events';
import { ExecuteNode } from './nodes/execute.node';
import { PlanNode } from './nodes/plan.node';
import { RecallNode } from './nodes/recall.node';
import { RememberNode } from './nodes/remember.node';
import { ReflectNode } from './nodes/reflect.node';
import { SynthesizeNode } from './nodes/synthesize.node';
import { TriageNode } from './nodes/triage.node';
import type { AgentTool } from './tools/agent-tool';
import { ToolRegistry } from './tools/tool-registry';
import { AbstentionConsistencyGuardrail } from '../guardrails/abstention-consistency.guardrail';
import { CitationCoverageGuardrail } from '../guardrails/citation-coverage.guardrail';
import { ExfiltrationGuardrail } from '../guardrails/exfiltration.guardrail';
import { GuardrailService } from '../guardrails/guardrail.service';
import { InjectionDetectionGuardrail } from '../guardrails/injection-detection.guardrail';
import { QuestionAbuseGuardrail } from '../guardrails/question-abuse.guardrail';
import { LangSmithTracing } from '../observability/langsmith-tracing.service';
import { TraceCollector } from '../observability/trace-collector.service';
import type { CheckpointRepository } from '../repositories/ports/checkpoint.repository';
import type { LongTermMemoryService } from '../memory/long-term-memory.service';
import type { MemoryFact } from '../memory/memory.types';
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
  /** Only consulted from turn two onward — `recall` is a no-op on a fresh session. */
  recall?: object;
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

      if (system.startsWith('You rewrite follow-up questions')) {
        payload = script.recall ?? { standalone: '', isFollowUp: false };
      } else if (system.startsWith('You triage questions')) {
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

/**
 * Long-term memory stubbed out: M4.2's funnel has its own spec, and a graph test
 * that also exercised extraction would be testing two things and reporting one.
 * `recall` returning nothing is the state a fresh install is in.
 */
const noMemory = () =>
  ({
    recall: () => Promise.resolve([]),
    remember: () => Promise.resolve({ stored: [], merged: [] }),
  }) as unknown as LongTermMemoryService;

/** Records the bound rather than pruning: retention has its own repository spec. */
class FakeCheckpointRepository implements CheckpointRepository {
  readonly limits: number[] = [];

  pruneToRecentSessions(limit: number): Promise<number> {
    this.limits.push(limit);
    return Promise.resolve(0);
  }
}

/** The production guardrail set, hand-wired — see the note at the call site. */
function realGuardrails(): GuardrailService {
  return new GuardrailService(
    new QuestionAbuseGuardrail(),
    new InjectionDetectionGuardrail(),
    new CitationCoverageGuardrail(),
    new ExfiltrationGuardrail(),
    new AbstentionConsistencyGuardrail(),
  );
}

function buildGraph(
  script: Script,
  overrides: Partial<AppConfigService> = {},
  traceRepo: TraceRepository = new FakeTraceRepository(),
  checkpointRepo: CheckpointRepository = new FakeCheckpointRepository(),
  memory: LongTermMemoryService = noMemory(),
  guardrails: GuardrailService = realGuardrails(),
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
    checkpointRetentionSessions: 7,
    ...overrides,
  } as unknown as AppConfigService;

  return new AgentGraphService(
    config,
    new RecallNode(llm, memory),
    new TriageNode(llm, registry),
    new PlanNode(llm, registry, config),
    new ExecuteNode(registry, noTracing()),
    new ReflectNode(llm, registry, config),
    new SynthesizeNode(llm),
    new RememberNode(memory),
    // The real guardrails, not a stub: they are deterministic and stateless, so
    // wiring the actual set is both cheaper than faking it and the only way these
    // tests would notice a guardrail that started throwing on a live answer.
    guardrails,
    new TraceCollector(traceRepo),
    // The real saver over an in-memory database, one per graph. A fake would make
    // the multi-turn tests below assert against a stub of the thing under test —
    // it is LangGraph's own resume semantics that carry short-term memory.
    new SqliteSaver(new Database(':memory:')),
    checkpointRepo,
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
    // Two planned sub-questions plus the reserved breadth search of the question
    // as asked (`sq0` — see plan.node.ts).
    expect(planCreated?.type === 'plan_created' && planCreated.subQuestions.length).toBe(3);

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
  it('does not let a throwing guardrail destroy an answer it has already delivered', async () => {
    // The sweep runs *after* `run_finished` is emitted, so a guardrail that threw
    // used to fall through to the enclosing catch: `run_failed` on a stream that
    // had already been told the run succeeded, and a trace recorded as
    // `status: 'failed'` with `answer: null`. The answer reached the client and
    // was then erased from the record, on behalf of a check whose only job is to
    // describe it.
    const traceRepo = new FakeTraceRepository();
    const broken = realGuardrails();
    jest
      .spyOn(broken, 'checkRun')
      .mockRejectedValue(new Error('guardrail exploded on a 2MB answer'));

    const graph = buildGraph(
      {
        triage: { complexity: 'simple', reasoning: 'one fact' },
        plan: { subQuestions: [] },
        reflect: [NO_GAP],
        synthesis: { answer: 'The date was 25 February [1].', abstained: false },
      },
      {},
      traceRepo,
      new FakeCheckpointRepository(),
      noMemory(),
      broken,
    );

    const result = await graph.run({ question: 'When did Helios ship?' });
    const types = result.events.map((e) => e.type);

    expect(types).not.toContain<AgentEventType>('run_failed');
    expect(types[types.length - 1]).toBe('run_finished');
    expect(result.answer.text).toBe('The date was 25 February [1].');
    // A sweep that could not run is a missing measurement, not a failed run.
    expect(result.guardrails).toEqual([]);

    const recorded = traceRepo.saved[traceRepo.saved.length - 1].run;
    expect(recorded.status).toBe('finished');
    expect(recorded.answer?.text).toBe('The date was 25 February [1].');
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
      const config = {
        maxHops: 2,
        maxFanOut: 5,
        agentTimeoutMs: 10_000,
        checkpointRetentionSessions: 7,
      } as AppConfigService;
      const graph = new AgentGraphService(
        config,
        new RecallNode(exploding, noMemory()),
        new TriageNode(exploding, registry),
        new PlanNode(exploding, registry, config),
        new ExecuteNode(registry, noTracing()),
        new ReflectNode(exploding, registry, config),
        new SynthesizeNode(exploding),
        new RememberNode(noMemory()),
        realGuardrails(),
        new TraceCollector(repo),
        new SqliteSaver(new Database(':memory:')),
        new FakeCheckpointRepository(),
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

  describe('short-term memory (M4.1)', () => {
    const script: Script = {
      triage: { complexity: 'simple', reasoning: 'one fact' },
      plan: { subQuestions: [] },
      reflect: [NO_GAP],
      synthesis: { answer: 'Priya Raman approved it [1].', abstained: false },
      recall: { standalone: 'Who approved the new Helios launch date?', isFollowUp: true },
    };

    it('tells the caller which session the run belongs to', async () => {
      const graph = buildGraph(script);

      const result = await graph.run({ question: 'Why did Helios slip?' });
      const started = result.events.find((event) => event.type === 'run_started');

      // The server mints the id when the caller sends none. Without it on the
      // wire the caller cannot ask a follow-up, and every question opens a new
      // conversation no matter how correct the checkpointer is.
      expect(started?.type === 'run_started' && started.sessionId).toBe(result.sessionId);
    });

    it('carries the previous turn into the next question on the same session', async () => {
      const graph = buildGraph(script);
      const sessionId = 'session-under-test';

      const first = await graph.run({ question: 'Why did Helios slip?', sessionId });
      expect(first.state.turns).toHaveLength(1);
      expect(first.state.turns[0]).toMatchObject({
        question: 'Why did Helios slip?',
        answer: 'Priya Raman approved it [1].',
        abstained: false,
      });

      const second = await graph.run({ question: 'Who approved it?', sessionId });

      // The whole point of M4.1: turn two resolved "it" out of turn one.
      const resolved = second.events.find((event) => event.type === 'followup_resolved');
      expect(resolved).toMatchObject({
        original: 'Who approved it?',
        resolved: 'Who approved the new Helios launch date?',
      });
      expect(second.state.turns).toHaveLength(2);
      expect(second.state.turns[1]).toMatchObject({
        question: 'Who approved it?',
        standalone: 'Who approved the new Helios launch date?',
      });
    });

    it('starts each turn from a clean slate but a remembered conversation', async () => {
      const graph = buildGraph(script);
      const sessionId = 'session-reset';

      const first = await graph.run({ question: 'Why did Helios slip?', sessionId });
      const second = await graph.run({ question: 'Who approved it?', sessionId });

      // The regression this exists for. The checkpointer resumes the *same*
      // thread, and every reducer here merges or appends — so without
      // NEW_TURN_RESET turn two inherits turn one's spent hop budget and its
      // event log, and reflects on a question it never asked.
      expect(second.state.hops).toBe(first.state.hops);
      // Per-run, not per-session: a second turn holding the first turn's events
      // would replay the previous answer to the UI before producing its own.
      expect(second.state.events.filter((event) => event.type === 'triage_done')).toHaveLength(1);

      // Evidence is deliberately not asserted here. It leaks the same way, but the
      // stub tools ignore their query and `mintEvidenceId` is a pure function of
      // `chunkId`, so both turns retrieve identical ids and the dedupe reducer
      // hides the leak. `hops` is the channel where it shows.
      expect(second.state.evidence.every((piece) => piece.retrievedBy !== undefined)).toBe(true);
    });

    it('keeps two sessions from seeing each other', async () => {
      const graph = buildGraph(script);

      await graph.run({ question: 'Why did Helios slip?', sessionId: 'session-a' });
      const other = await graph.run({ question: 'Who approved it?', sessionId: 'session-b' });

      // A fresh session has no history, so `recall` never calls a model — and
      // "it" stays unresolved rather than being resolved out of someone else's
      // conversation.
      expect(other.events.some((event) => event.type === 'followup_resolved')).toBe(false);
      expect(other.state.turns).toHaveLength(1);
    });

    it('records the turn even when the run abstained', async () => {
      const graph = buildGraph({
        ...script,
        synthesis: { answer: 'I could not find this in the available sources.', abstained: true },
      });

      const result = await graph.run({ question: 'What is the CEO shoe size?' });

      // A session that only remembered what it answered well would let the next
      // turn resolve "why not?" against a conversation missing the turn that
      // said no.
      expect(result.state.turns).toHaveLength(1);
      expect(result.state.turns[0].abstained).toBe(true);
      expect(result.events.some((event) => event.type === 'memory_written')).toBe(true);
    });

    it('bounds the checkpoint store after every run, including a failed one', async () => {
      const checkpoints = new FakeCheckpointRepository();
      const graph = buildGraph(script, {}, new FakeTraceRepository(), checkpoints);

      await graph.run({ question: 'Why did Helios slip?' });

      // 7 is this harness's own bound, deliberately not the schema default — the
      // assertion is that the configured value reaches the repository, not what
      // the default happens to be.
      expect(checkpoints.limits).toEqual([7]);
    });
  });

  describe('long-term memory (M4.2)', () => {
    const script: Script = {
      triage: { complexity: 'complex', reasoning: 'needs two sources' },
      plan: {
        subQuestions: [{ id: 'sq1', text: 'What slipped?', tool: 'mail_search', dependsOn: [] }],
      },
      reflect: [NO_GAP],
      synthesis: { answer: 'Helios slipped [1].', abstained: false },
    };

    const remembered: MemoryFact = {
      id: 4,
      text: 'The user works on the Helios project.',
      kind: 'relationship',
      importance: 0.8,
      accessCount: 1,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      lastUsedAt: null,
      sourceRunId: 'run-0',
      sourceSessionId: 'session-0',
    };

    function recallingMemory(facts: MemoryFact[]): LongTermMemoryService {
      return {
        recall: () => Promise.resolve(facts),
        remember: () => Promise.resolve({ stored: [], merged: [] }),
      } as unknown as LongTermMemoryService;
    }

    it('puts recalled facts in front of the planner and the synthesiser', async () => {
      const prompts: string[] = [];
      const llm: LlmService = {
        chat: (messages, options) => {
          prompts.push(`${options?.system ?? ''} ${messages.map((m) => m.content).join()}`);
          return scriptedLlm(script).chat(messages, options);
        },
      };
      const registry = new ToolRegistry([tool('mail_search', [1, 2])]);
      const config = {
        maxHops: 2,
        maxFanOut: 5,
        agentTimeoutMs: 10_000,
        checkpointRetentionSessions: 7,
      } as unknown as AppConfigService;
      const memory = recallingMemory([remembered]);

      const graph = new AgentGraphService(
        config,
        new RecallNode(llm, memory),
        new TriageNode(llm, registry),
        new PlanNode(llm, registry, config),
        new ExecuteNode(registry, noTracing()),
        new ReflectNode(llm, registry, config),
        new SynthesizeNode(llm),
        new RememberNode(memory),
        realGuardrails(),
        new TraceCollector(new FakeTraceRepository()),
        new SqliteSaver(new Database(':memory:')),
        new FakeCheckpointRepository(),
      );

      await graph.run({ question: 'Did it ship?' });

      const planner = prompts.find((prompt) => prompt.startsWith('You plan retrieval'));
      const synth = prompts.find((prompt) => prompt.startsWith('You answer questions using only'));

      // §5/M4.2's "inject the top few into planner context" — and into synthesis,
      // which is where a remembered preference visibly changes an answer.
      expect(planner).toContain('The user works on the Helios project.');
      expect(synth).toContain('The user works on the Helios project.');
    });

    it('emits recalled facts as a memory read, distinguishable from session turns', async () => {
      const graph = buildGraph(
        script,
        {},
        new FakeTraceRepository(),
        new FakeCheckpointRepository(),
        recallingMemory([remembered]),
      );

      const result = await graph.run({ question: 'Did it ship?' });
      const read = result.events.find((event) => event.type === 'memory_read');

      expect(read?.type === 'memory_read' && read.refs).toEqual([
        { id: 'fact-4', kind: 'relationship', text: 'The user works on the Helios project.' },
      ]);
    });

    it('extracts only after the answer has streamed', async () => {
      const repo = new FakeTraceRepository();
      const graph = buildGraph(script, {}, repo, new FakeCheckpointRepository());

      const result = await graph.run({ question: 'Did it ship?' });
      const spans = (await repo.get(result.runId))?.spans ?? [];

      const synthesize = spans.find((span) => span.kind === 'node' && span.name === 'synthesize');
      const remember = spans.find((span) => span.kind === 'node' && span.name === 'remember');

      // Extraction is a model call that has nothing to do with the visitor's
      // question. Ahead of synthesis it would delay the answer itself; here only
      // `run_finished` waits, and the UI is already rendering the text.
      expect(remember).toBeDefined();
      expect(Date.parse(remember!.startedAt)).toBeGreaterThanOrEqual(
        Date.parse(synthesize!.endedAt),
      );

      const types = result.events.map((event) => event.type);
      expect(types.indexOf('token_delta')).toBeLessThan(types.indexOf('run_finished'));
    });

    it('runs a question through unchanged when memory holds nothing', async () => {
      const graph = buildGraph(script);
      const result = await graph.run({ question: 'Did it ship?' });

      // A fresh install must not emit an empty `memory_read`: the event means
      // "memory contributed this", not "memory was consulted".
      expect(result.events.some((event) => event.type === 'memory_read')).toBe(false);
      expect(result.answer.text).toContain('Helios slipped');
    });
  });
});

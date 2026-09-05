import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { END, START, StateGraph, type LangGraphRunnableConfig } from '@langchain/langgraph';
import { AppConfigService } from '../config/app-config.service';
import type { AgentAnswer } from './agent.types';
import { AGENT_RUN_CONTEXT, beginNodeSpan, type AgentRunContext } from './agent-run-context';
import { TraceCollector } from '../observability/trace-collector.service';
import type { AgentEvent, AgentEventSink, EmittedAgentEvent } from './events';
import { ExecuteNode } from './nodes/execute.node';
import { PlanNode } from './nodes/plan.node';
import { ReflectNode } from './nodes/reflect.node';
import { SynthesizeNode } from './nodes/synthesize.node';
import { TriageNode } from './nodes/triage.node';
import { AgentStateAnnotation, type AgentState } from './state';

export interface AgentRunOptions {
  question: string;
  sessionId?: string;
  /** Receives every event as it happens. Omit for a non-streaming run. */
  sink?: AgentEventSink;
  /** Caller-owned cancellation — a closed SSE connection, typically. */
  signal?: AbortSignal;
}

export interface AgentRunResult {
  runId: string;
  sessionId: string;
  question: string;
  answer: AgentAnswer;
  state: AgentState;
  events: EmittedAgentEvent[];
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number | null;
  latencyMs: number;
}

/**
 * Owns the compiled LangGraph state machine and the lifecycle around one run.
 *
 * The graph is compiled once at construction — it is a pure description of
 * control flow, and everything per-run (event sink, abort signal, usage totals)
 * travels through `configurable` instead. See {@link AgentRunContext}.
 */
@Injectable()
export class AgentGraphService {
  private readonly logger = new Logger(AgentGraphService.name);
  // Deliberately un-annotated: LangGraph's compiled-graph generics carry the
  // state shape, and naming the type by hand widens it back to `unknown`.
  private readonly graph: ReturnType<AgentGraphService['build']>;

  constructor(
    private readonly config: AppConfigService,
    private readonly triageNode: TriageNode,
    private readonly planNode: PlanNode,
    private readonly executeNode: ExecuteNode,
    private readonly reflectNode: ReflectNode,
    private readonly synthesizeNode: SynthesizeNode,
    private readonly traces: TraceCollector,
  ) {
    this.graph = this.build();
  }

  private build() {
    // Every node goes through `timed`, which is the only place a node span can be
    // opened and closed around the real call. Doing it here rather than inside each
    // node keeps the nodes unaware of tracing, and means a node added later is
    // traced by construction rather than by remembering to instrument it.
    const builder = new StateGraph(AgentStateAnnotation)
      .addNode('triage', (state, config) =>
        this.timed('triage', config, () => this.triageNode.run(state, config)),
      )
      .addNode('plan', (state, config) =>
        this.timed('plan', config, () => this.planNode.run(state, config)),
      )
      .addNode('execute', (state, config) =>
        this.timed('execute', config, () => this.executeNode.run(state, config)),
      )
      .addNode('reflect', (state, config) =>
        this.timed('reflect', config, () => this.reflectNode.run(state, config)),
      )
      .addNode('synthesize', (state, config) =>
        this.timed('synthesize', config, () => this.synthesizeNode.run(state, config)),
      )
      .addEdge(START, 'triage')
      // A simple question skips planning entirely; triage has already seeded the
      // single broad retrieval that `execute` will run.
      .addConditionalEdges(
        'triage',
        (state: AgentState) => (state.complexity === 'simple' ? 'execute' : 'plan'),
        { execute: 'execute', plan: 'plan' },
      )
      .addEdge('plan', 'execute')
      .addEdge('execute', 'reflect')
      .addConditionalEdges(
        'reflect',
        (state: AgentState) => (this.shouldLoop(state) ? 'execute' : 'synthesize'),
        { execute: 'execute', synthesize: 'synthesize' },
      )
      .addEdge('synthesize', END);

    return builder.compile();
  }

  /**
   * Times one node, as a span.
   *
   * Takes a thunk rather than returning a wrapper because `addNode` is what
   * contextually types `state` — hoisting the arrow out of its argument position
   * collapses the graph's whole state shape to `unknown`.
   *
   * A node that throws still closes its span, with the error recorded on it: a
   * node that failed is the most interesting thing a trace can show, and a tree
   * missing its failed node points at the wrong one.
   */
  private async timed<TResult>(
    name: string,
    config: LangGraphRunnableConfig,
    run: () => Promise<TResult>,
  ): Promise<TResult> {
    const endSpan = beginNodeSpan(config, name);
    try {
      const result = await run();
      endSpan();
      return result;
    } catch (error) {
      endSpan(error);
      throw error;
    }
  }

  /**
   * `reflect` already refuses to propose follow-ups past the hop budget, so the
   * pending check is the real condition here. Re-checking `maxHops` anyway keeps
   * the loop guard local to the edge that can actually loop.
   */
  private shouldLoop(state: AgentState): boolean {
    const hasPending = state.subQuestions.some((sq) => sq.status === 'pending');
    return hasPending && state.hops <= this.config.maxHops;
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const runId = randomUUID();
    const sessionId = options.sessionId ?? randomUUID();
    const started = Date.now();
    const startedAt = new Date(started).toISOString();

    const events: EmittedAgentEvent[] = [];
    const sink: AgentEventSink = (event) => {
      events.push(event);
      options.sink?.(event);
    };

    // Two independent reasons to stop — the wall-clock budget and the caller
    // hanging up — collapse into the one signal the nodes actually check.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.agentTimeoutMs);
    const abortFromCaller = () => controller.abort();
    // Check before subscribing: a caller can hand over a signal that has already
    // fired, and `addEventListener` would then never run — the run would proceed as
    // if nobody had cancelled it. Cheap to guard, and silent when missed.
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });

    const rootSpanId = randomUUID();
    const context: AgentRunContext = {
      runId,
      sessionId,
      sink,
      signal: controller.signal,
      counter: { seq: 0 },
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      models: [],
      spans: [],
      rootSpanId,
      activeNodeSpanId: null,
    };

    const emit = (event: AgentEvent) =>
      sink({ ...event, seq: context.counter.seq++, ts: new Date().toISOString() });

    emit({ type: 'run_started', runId, question: options.question });

    try {
      const state = await this.graph.invoke(
        { question: options.question, sessionId, runId },
        { configurable: { [AGENT_RUN_CONTEXT]: context } },
      );

      const answer = state.answer ?? {
        text: 'I could not find this in the available sources.',
        citations: [],
        abstained: true,
      };
      const latencyMs = Date.now() - started;

      emit({
        type: 'run_finished',
        answer,
        citations: answer.citations,
        usage: { inputTokens: context.usage.inputTokens, outputTokens: context.usage.outputTokens },
        costUsd: context.usage.costUsd,
        latencyMs,
        models: context.models,
      });

      this.logger.log(
        `Run ${runId} finished in ${latencyMs}ms — ${state.complexity}, ${state.evidence.length} evidence, ${answer.citations.length} citations`,
      );

      await this.traces.record({
        runId,
        sessionId,
        question: options.question,
        startedAt,
        status: 'finished',
        answer,
        citations: answer.citations,
        events,
        usage: {
          inputTokens: context.usage.inputTokens,
          outputTokens: context.usage.outputTokens,
        },
        costUsd: context.usage.costUsd,
        latencyMs,
        models: context.models,
        error: null,
        spans: context.spans,
        rootSpanId,
      });

      return {
        runId,
        sessionId,
        question: options.question,
        answer,
        state,
        events,
        usage: {
          inputTokens: context.usage.inputTokens,
          outputTokens: context.usage.outputTokens,
        },
        costUsd: context.usage.costUsd,
        latencyMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Run ${runId} failed: ${message}`);
      emit({ type: 'run_failed', error: message });

      // A failed run is the one most worth having a trace of, and the in-memory
      // store it replaces kept none — it only ever saw runs that returned.
      await this.traces.record({
        runId,
        sessionId,
        question: options.question,
        startedAt,
        status: 'failed',
        answer: null,
        citations: [],
        events,
        usage: {
          inputTokens: context.usage.inputTokens,
          outputTokens: context.usage.outputTokens,
        },
        costUsd: context.usage.costUsd,
        latencyMs: Date.now() - started,
        models: context.models,
        error: message,
        spans: context.spans,
        rootSpanId,
      });

      throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { END, START, StateGraph } from '@langchain/langgraph';
import { AppConfigService } from '../config/app-config.service';
import type { AgentAnswer } from './agent.types';
import { AGENT_RUN_CONTEXT, type AgentRunContext } from './agent-run-context';
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
  ) {
    this.graph = this.build();
  }

  private build() {
    const builder = new StateGraph(AgentStateAnnotation)
      .addNode('triage', (state, config) => this.triageNode.run(state, config))
      .addNode('plan', (state, config) => this.planNode.run(state, config))
      .addNode('execute', (state, config) => this.executeNode.run(state, config))
      .addNode('reflect', (state, config) => this.reflectNode.run(state, config))
      .addNode('synthesize', (state, config) => this.synthesizeNode.run(state, config))
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
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });

    const context: AgentRunContext = {
      runId,
      sessionId,
      sink,
      signal: controller.signal,
      counter: { seq: 0 },
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
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
      });

      this.logger.log(
        `Run ${runId} finished in ${latencyMs}ms — ${state.complexity}, ${state.evidence.length} evidence, ${answer.citations.length} citations`,
      );

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
      throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  END,
  START,
  StateGraph,
  type BaseCheckpointSaver,
  type LangGraphRunnableConfig,
} from '@langchain/langgraph';
import { AppConfigService } from '../config/app-config.service';
import { GuardrailService } from '../guardrails/guardrail.service';
import type { GuardrailVerdict, RunContext } from '../guardrails/guardrail';
import { AGENT_CHECKPOINTER } from './checkpointing/agent-checkpointer';
import { CHECKPOINT_REPOSITORY } from '../repositories/ports/tokens';
import type { CheckpointRepository } from '../repositories/ports/checkpoint.repository';
import type { AgentAnswer } from './agent.types';
import { AGENT_RUN_CONTEXT, beginNodeSpan, type AgentRunContext } from './agent-run-context';
import { TraceCollector } from '../observability/trace-collector.service';
import type { AgentEvent, AgentEventSink, EmittedAgentEvent } from './events';
import { ExecuteNode } from './nodes/execute.node';
import { PlanNode } from './nodes/plan.node';
import { RecallNode } from './nodes/recall.node';
import { RememberNode } from './nodes/remember.node';
import { ReflectNode } from './nodes/reflect.node';
import { SynthesizeNode } from './nodes/synthesize.node';
import { TriageNode } from './nodes/triage.node';
import { AgentStateAnnotation, NEW_TURN_RESET, type AgentState } from './state';

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
  /**
   * What the post-run guardrails concluded (PLAN.md §5/M6.2).
   *
   * Returned rather than only logged so the eval harness scores the verdicts the
   * live pipeline actually produced, instead of re-deriving them from the answer
   * text and slowly drifting from what ships. Not on the event contract: that is
   * frozen and append-only, and no consumer renders these yet.
   */
  guardrails: GuardrailVerdict[];
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
    private readonly recallNode: RecallNode,
    private readonly triageNode: TriageNode,
    private readonly planNode: PlanNode,
    private readonly executeNode: ExecuteNode,
    private readonly reflectNode: ReflectNode,
    private readonly synthesizeNode: SynthesizeNode,
    private readonly rememberNode: RememberNode,
    private readonly guardrails: GuardrailService,
    private readonly traces: TraceCollector,
    @Inject(AGENT_CHECKPOINTER) private readonly checkpointer: BaseCheckpointSaver,
    @Inject(CHECKPOINT_REPOSITORY) private readonly checkpoints: CheckpointRepository,
  ) {
    this.graph = this.build();
  }

  private build() {
    // Every node goes through `timed`, which is the only place a node span can be
    // opened and closed around the real call. Doing it here rather than inside each
    // node keeps the nodes unaware of tracing, and means a node added later is
    // traced by construction rather than by remembering to instrument it.
    const builder = new StateGraph(AgentStateAnnotation)
      .addNode('recall', (state, config) =>
        this.timed('recall', config, () => this.recallNode.run(state, config)),
      )
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
      .addNode('remember', (state, config) =>
        this.timed('remember', config, () => this.rememberNode.run(state, config)),
      )
      // `recall` first, so a follow-up is resolved into a standalone question
      // before anything reads it. It costs no model call on the first turn of a
      // session, which is the common case (PLAN.md §5/M4.1).
      .addEdge(START, 'recall')
      .addEdge('recall', 'triage')
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
      // After synthesis, not before: extraction needs the answer, and by this
      // point the answer has already streamed as `token_delta`. Only the stats
      // in `run_finished` wait on it (PLAN.md §5/M4.2).
      .addEdge('synthesize', 'remember')
      .addEdge('remember', END);

    // Keyed by `sessionId` at invoke time — see `run()`. The checkpointer is what
    // makes `state.turns` outlive a run, and it is also why every other channel
    // has to be explicitly cleared per turn (see NEW_TURN_RESET).
    return builder.compile({ checkpointer: this.checkpointer });
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

    // `sessionId` rides along because the server mints it when the caller sent
    // none: without it on the wire a client has no way to ask a follow-up, and
    // every question would open a new conversation (PLAN.md §5/M4.1).
    emit({ type: 'run_started', runId, question: options.question, sessionId });

    try {
      const state = await this.graph.invoke(
        {
          question: options.question,
          askedQuestion: options.question,
          sessionId,
          runId,
          // The session's thread already holds the previous turn's evidence,
          // sub-questions and hop count. Everything but `turns` is cleared here.
          ...NEW_TURN_RESET,
        },
        {
          configurable: {
            [AGENT_RUN_CONTEXT]: context,
            // The checkpointer's key. One session is one LangGraph thread, which
            // is what makes turn two able to see turn one at all.
            thread_id: sessionId,
          },
        },
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
        `Run ${runId} finished in ${latencyMs}ms — ${state.complexity}, ${state.evidence.length} evidence, ` +
          `${answer.citations.length} citations, turn ${state.turns.length} of session ${sessionId}`,
      );

      // After `run_finished`, so nothing about the guardrail sweep sits between a
      // finished answer and the client reading it. The checks are deterministic
      // and stateless — no model call, no I/O — and they report rather than
      // intervene: an answer is never withheld or rewritten here. What they buy
      // is that the same verdicts the eval suite scores are also produced on every
      // live run, so the numbers describe the deployed system (PLAN.md §5/M6.2).
      //
      // Contained rather than left to the enclosing `catch`, and the placement is
      // the whole reason. The client has already been sent `run_finished`; a
      // guardrail that threw would fall through to the failure path, emit
      // `run_failed` on the same stream, and record `status: 'failed'` with
      // `answer: null` — destroying the trace of an answer that was successfully
      // delivered, on behalf of a check whose only job is to describe it. A sweep
      // that cannot run is a missing measurement, not a failed run.
      const guardrails = await this.runGuardrails(runId, {
        question: options.question,
        answer,
        evidence: state.evidence,
      });

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
        guardrails,
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
      await this.pruneSessions();
    }
  }

  /**
   * Runs the post-run guardrails, absorbing a failure rather than propagating it.
   *
   * See the call site for why this cannot be allowed to throw. The verdicts are
   * returned on `AgentRunResult` and are deliberately *not* on the event contract,
   * which stays frozen (PLAN.md §5/M6.2).
   */
  private async runGuardrails(runId: string, context: RunContext): Promise<GuardrailVerdict[]> {
    try {
      const verdicts = await this.guardrails.checkRun(context);
      this.guardrails.report(runId, verdicts);
      return verdicts;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Run ${runId}: the guardrail sweep failed and was skipped — ${message}`);
      return [];
    }
  }

  /**
   * Bounds the checkpoint store to the most recent sessions.
   *
   * Runs after every run, including a failed one — a run that died mid-graph is
   * exactly the one that leaves a half-finished thread behind. Failing to prune
   * must never fail the run that just succeeded, so it is logged and swallowed:
   * the answer is already on the wire by this point.
   */
  private async pruneSessions(): Promise<void> {
    try {
      const dropped = await this.checkpoints.pruneToRecentSessions(
        this.config.checkpointRetentionSessions,
      );
      if (dropped > 0) {
        this.logger.debug(`Pruned ${dropped} session(s) from the checkpoint store`);
      }
    } catch (error) {
      this.logger.warn(
        `Could not prune the checkpoint store: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}

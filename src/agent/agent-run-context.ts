import { randomUUID } from 'node:crypto';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { ChatResult } from '../ai/llm/llm.types';
import type { TokenUsage } from './agent.types';
import type { AgentEvent, AgentEventSink } from './events';
import type { RunSpan } from '../common/types/trace.types';

/**
 * Per-run plumbing that is deliberately *not* graph state: an event sink the run
 * started with, the abort signal enforcing the wall-clock budget, and a sequence
 * counter. None of it is serialisable, and none of it should end up in a
 * checkpoint, so it travels through LangGraph's `configurable` bag instead.
 */
export interface AgentRunContext {
  runId: string;
  sessionId: string;
  sink: AgentEventSink;
  signal: AbortSignal;
  /** Mutable so every node in the run shares one monotonic sequence. */
  counter: { seq: number };
  /** Accumulated across every model call the run makes, for `run_finished`. */
  usage: TokenUsage & { costUsd: number | null };
  /**
   * Every distinct `provider/model` the run was served by, in first-use order.
   * A list rather than a single value because failover can change vendor
   * mid-run, and a stats panel claiming one provider served a run that two did
   * would be quietly wrong.
   */
  models: string[];
  /**
   * Spans the event contract cannot express.
   *
   * Tool spans are derivable from `tool_started`/`tool_finished`, but node and
   * model timings are not on the wire at all — and `events.ts` is frozen and
   * append-only, so adding events for them would mean a hand-mirrored change in
   * `ui/lib/agent-events.ts` to render something the UI has no use for. They are
   * collected here instead and merged in by `TraceCollector`.
   */
  spans: RunSpan[];
  /** Root span id, so a model call outside any node still has a parent. */
  rootSpanId: string;
  /** The node currently executing; model calls hang from it. */
  activeNodeSpanId: string | null;
}

export const AGENT_RUN_CONTEXT = 'agentRunContext';

function isAgentRunContext(value: unknown): value is AgentRunContext {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AgentRunContext>;
  return typeof candidate.runId === 'string' && typeof candidate.sink === 'function';
}

/**
 * Node-side event helper. Returns both an `emit` that pushes straight to the
 * live sink and the accumulated list, because every event has to do two jobs:
 * stream now (SSE) and persist into state for `GET /agent/runs/:runId` replay.
 */
export function createEmitter(config: LangGraphRunnableConfig): {
  emit: (event: AgentEvent) => void;
  events: AgentEvent[];
} {
  const context = getRunContext(config);
  const events: AgentEvent[] = [];

  return {
    events,
    emit(event: AgentEvent) {
      events.push(event);
      context.sink({ ...event, seq: context.counter.seq++, ts: new Date().toISOString() });
    },
  };
}

/**
 * Folds one model call's usage into the run total, and records the call as a span.
 *
 * A single unpriced call makes the whole run's cost `null` rather than
 * understated — the provider prices each call from `src/config/model-prices.ts`,
 * and a model missing from that table has an unknown cost, not a free one. A total
 * that quietly omitted a call would read as authoritative while being wrong.
 */
export function recordUsage(config: LangGraphRunnableConfig, result: ChatResult): void {
  const context = getRunContext(config);
  const { usage, models } = context;

  const served = `${result.provider}/${result.model}`;
  if (!models.includes(served)) models.push(served);

  usage.inputTokens += result.usage.inputTokens;
  usage.outputTokens += result.usage.outputTokens;
  usage.costUsd =
    result.costUsd === null || usage.costUsd === null ? null : usage.costUsd + result.costUsd;

  // Back-dated from the return: the provider measures the call and hands back a
  // duration, and this runs the moment it returns. Recording `now` as the start
  // would make every model call look instantaneous.
  const endedAt = Date.now();
  context.spans.push({
    spanId: randomUUID(),
    parentSpanId: context.activeNodeSpanId ?? context.rootSpanId,
    name: served,
    kind: 'llm',
    startedAt: new Date(endedAt - result.latencyMs).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: result.latencyMs,
    error: null,
    attributes: {
      provider: result.provider,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: result.costUsd,
    },
  });
}

/**
 * Times one graph node, returning the function that closes the span.
 *
 * Node spans are what give the local trace the same planner → tool → LLM shape
 * LangSmith shows (PLAN.md §5/M3.1), and they are recorded here rather than
 * inferred from the ordering of `*_done` events — inference would be wrong the
 * moment `reflect` loops back into `execute`, which is the one case the trace
 * exists to make legible.
 */
export function beginNodeSpan(
  config: LangGraphRunnableConfig,
  name: string,
): (error?: unknown) => void {
  const context = getRunContext(config);
  const spanId = randomUUID();
  const startedAt = Date.now();
  const parentSpanId = context.rootSpanId;

  context.activeNodeSpanId = spanId;

  return (error?: unknown) => {
    const endedAt = Date.now();
    context.spans.push({
      spanId,
      parentSpanId,
      name,
      kind: 'node',
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      durationMs: endedAt - startedAt,
      error: error === undefined ? null : describeError(error),
      attributes: {},
    });
    // Nodes run one at a time in this graph — the only fan-out is over tools
    // *inside* `execute` — so clearing rather than restoring a stack is accurate.
    // Revisit if the graph ever gains genuinely parallel branches.
    context.activeNodeSpanId = null;
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getRunContext(config: LangGraphRunnableConfig): AgentRunContext {
  // `configurable` is typed as Record<string, any>, so narrow through `unknown`
  // rather than trusting the index signature.
  const candidate: unknown = config.configurable?.[AGENT_RUN_CONTEXT];
  if (!isAgentRunContext(candidate)) {
    throw new Error(
      'Agent run context missing from graph config — the graph must be invoked through AgentGraphService.run()',
    );
  }
  return candidate;
}

import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { ChatResult } from '../ai/llm/llm.types';
import type { TokenUsage } from './agent.types';
import type { AgentEvent, AgentEventSink } from './events';

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
 * Folds one model call's usage into the run total. Costs stay `null` until a
 * per-model price table exists, and a single unpriced call makes the whole run's
 * cost unknown rather than understated.
 */
export function recordUsage(config: LangGraphRunnableConfig, result: ChatResult): void {
  const { usage, models } = getRunContext(config);

  const served = `${result.provider}/${result.model}`;
  if (!models.includes(served)) models.push(served);

  usage.inputTokens += result.usage.inputTokens;
  usage.outputTokens += result.usage.outputTokens;
  usage.costUsd =
    result.costUsd === null || usage.costUsd === null ? null : usage.costUsd + result.costUsd;
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

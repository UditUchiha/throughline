import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AgentAnswer, Citation, TokenUsage } from '../agent/agent.types';
import type { EmittedAgentEvent } from '../agent/events';
import type { PersistedRun, RunSpan } from '../common/types/trace.types';
import { TRACE_REPOSITORY } from '../repositories/ports/tokens';
import type { TraceRepository } from '../repositories/ports/trace.repository';

export interface TraceInput {
  runId: string;
  sessionId: string;
  question: string;
  startedAt: string;
  status: 'finished' | 'failed';
  answer: AgentAnswer | null;
  citations: Citation[];
  events: EmittedAgentEvent[];
  usage: TokenUsage;
  costUsd: number | null;
  latencyMs: number;
  models: string[];
  error: string | null;
  /** Node and model spans from the run context; tool spans are derived here. */
  spans: RunSpan[];
  rootSpanId: string;
}

/**
 * Persists a finished run and reconstructs its span tree (PLAN.md §5/M3.2).
 *
 * Spans arrive from two places, because no single one has all of them: node and
 * model timings are measured in the run context (the event contract is frozen and
 * carries neither), while tool timings are already on the wire and are derived
 * here from the events themselves.
 */
@Injectable()
export class TraceCollector {
  private readonly logger = new Logger(TraceCollector.name);

  constructor(@Inject(TRACE_REPOSITORY) private readonly traces: TraceRepository) {}

  /**
   * Never throws. A trace is a record *about* a run — losing one is a gap in
   * observability, and turning it into a failed request would let the observer
   * break the thing it observes.
   */
  async record(input: TraceInput): Promise<void> {
    try {
      const finishedAt = new Date(Date.parse(input.startedAt) + input.latencyMs).toISOString();

      const run: PersistedRun = {
        runId: input.runId,
        sessionId: input.sessionId,
        question: input.question,
        startedAt: input.startedAt,
        finishedAt,
        status: input.status,
        answer: input.answer,
        citations: input.citations,
        events: input.events,
        usage: input.usage,
        costUsd: input.costUsd,
        latencyMs: input.latencyMs,
        models: input.models,
        error: input.error,
      };

      const root: RunSpan = {
        spanId: input.rootSpanId,
        parentSpanId: null,
        name: 'agent_run',
        kind: 'run',
        startedAt: input.startedAt,
        endedAt: finishedAt,
        durationMs: input.latencyMs,
        error: input.error,
        attributes: {
          question: input.question,
          status: input.status,
          models: input.models,
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          costUsd: input.costUsd,
        },
      };

      const nodeSpans = input.spans.filter((span) => span.kind === 'node');
      const toolSpans = deriveToolSpans(input.events, nodeSpans, input.rootSpanId);

      await this.traces.save(run, [root, ...input.spans, ...toolSpans]);
    } catch (error) {
      this.logger.warn(
        `Could not persist trace for run ${input.runId}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
}

/**
 * Rebuilds one span per retrieval call from the event stream.
 *
 * Keyed by `subQuestionId` rather than by tool name: `execute` fans out across
 * tools concurrently, and two sub-questions routinely use the same tool in one
 * hop, so the tool name alone would collide and interleave two calls into one
 * span.
 */
function deriveToolSpans(
  events: EmittedAgentEvent[],
  nodeSpans: RunSpan[],
  rootSpanId: string,
): RunSpan[] {
  const pending = new Map<string, EmittedAgentEvent & { type: 'tool_started' }>();
  const spans: RunSpan[] = [];

  for (const event of events) {
    if (event.type === 'tool_started') {
      pending.set(event.subQuestionId, event);
      continue;
    }
    if (event.type !== 'tool_finished') continue;

    const started = pending.get(event.subQuestionId);
    pending.delete(event.subQuestionId);

    // Every path in `execute` pairs the two events — even the unknown-tool one,
    // which emits `tool_started` for a call that never ran so a consumer is not
    // left with a sub-question pending forever. So `started` should always be
    // there; this is defensive against an event list that is not, such as one
    // truncated by a failed run. Back-date from the end rather than drop the
    // span: a tool call missing from a trace reads as one that never happened.
    const endedAtMs = Date.parse(event.ts);
    const startedAtMs = started ? Date.parse(started.ts) : endedAtMs - event.latencyMs;

    spans.push({
      spanId: randomUUID(),
      parentSpanId: enclosingNodeSpanId(nodeSpans, startedAtMs) ?? rootSpanId,
      name: event.tool,
      kind: 'tool',
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: event.latencyMs,
      error: event.error ?? null,
      attributes: {
        subQuestionId: event.subQuestionId,
        query: started?.input,
        // Distinguishes "matched nothing" from "threw" for anyone reading the
        // trace, the same way `error` does on the wire.
        evidenceCount: event.evidenceIds.length,
      },
    });
  }

  return spans;
}

/**
 * The node span that was running at `atMs`.
 *
 * Tool spans come from the event stream, which has no idea what a node is, so
 * their parent is resolved by containment. `execute` can run more than once — a
 * second hop re-enters it — so this has to match on the interval rather than just
 * finding the node by name.
 */
function enclosingNodeSpanId(nodeSpans: RunSpan[], atMs: number): string | null {
  const match = nodeSpans.find(
    (span) => Date.parse(span.startedAt) <= atMs && atMs <= Date.parse(span.endedAt),
  );
  return match?.spanId ?? null;
}

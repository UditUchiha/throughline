import { Injectable } from '@nestjs/common';
import type { AgentAnswer } from './agent.types';
import type { EmittedAgentEvent } from './events';
import type { AgentRunResult } from './agent-graph.service';

export interface RecordedRun {
  runId: string;
  sessionId: string;
  question: string;
  startedAt: string;
  finishedAt: string;
  answer: AgentAnswer;
  events: EmittedAgentEvent[];
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number | null;
  latencyMs: number;
}

/**
 * Holds finished runs so `GET /agent/runs/:runId` can replay one.
 *
 * In-memory and capacity-bounded on purpose: this exists to make a deep-link
 * work within a session, not to be a trace store. Durable tracing is M3, and
 * building the persistence for it now would be an abstraction ahead of its
 * second caller (PLAN.md §0.4).
 */
@Injectable()
export class AgentRunStore {
  private static readonly MAX_RUNS = 100;
  private readonly runs = new Map<string, RecordedRun>();

  save(result: AgentRunResult, startedAt: string): void {
    // Map preserves insertion order, so the oldest key is the first one.
    if (this.runs.size >= AgentRunStore.MAX_RUNS) {
      const oldest = this.runs.keys().next();
      if (!oldest.done) this.runs.delete(oldest.value);
    }

    this.runs.set(result.runId, {
      runId: result.runId,
      sessionId: result.sessionId,
      question: result.question,
      startedAt,
      finishedAt: new Date().toISOString(),
      answer: result.answer,
      events: result.events,
      usage: result.usage,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
    });
  }

  get(runId: string): RecordedRun | undefined {
    return this.runs.get(runId);
  }
}

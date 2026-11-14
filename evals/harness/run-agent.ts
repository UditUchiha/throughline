import type { INestApplicationContext } from '@nestjs/common';
import { AgentGraphService } from '../../src/agent/agent-graph.service';
import type { EmittedAgentEvent } from '../../src/agent/events';
import type { GuardrailVerdict } from '../../src/guardrails/guardrail';
import { MEMORY_REPOSITORY } from '../../src/repositories/ports/tokens';
import type { MemoryRepository } from '../../src/repositories/ports/memory.repository';
import type { MemoryFunnel } from '../../src/memory/memory.types';
import { extraRetrievalRounds } from '../metrics/plan-quality';
import type {
  EvalQuestion,
  EvalRun,
  EvidenceRecord,
  GuardrailScore,
  MemoryActivity,
} from '../types';

/**
 * Runs one question through the real graph and records what it did.
 *
 * No `sessionId` is passed, so every question opens its own LangGraph thread and
 * short-term memory cannot leak between questions. Long-term memory is the half
 * that does leak, and it is handled by {@link MemoryProbe} below.
 */

/**
 * Reads the long-term memory funnel either side of a run, and optionally clears
 * the store between questions.
 *
 * **This is the decision the suite has to make explicitly.** PLAN.md §5/M6.1 asks
 * for the funnel yield over the same 59 runs, which needs memory *on*; but
 * `recall` injects remembered facts into the planner before `triage` and
 * `remember` writes after every answered run, so running 59 questions in sequence
 * means question 30 is influenced by facts extracted from questions 1–29. The
 * suite becomes order-dependent and stops being reproducible. The two
 * requirements pull opposite ways and the resolution has to be deliberate.
 *
 * `reset` (the default) clears the stored facts between questions. Memory stays
 * fully enabled — extraction still runs, still scores, still deduplicates, and
 * the cumulative counters still accumulate — so the funnel is measured; what
 * changes is that `recall` always faces an empty store, which makes
 * cross-question contamination structurally impossible rather than merely
 * unlikely.
 *
 * The price is real and is stated rather than hidden: with the store cleared,
 * deduplication can only fire *within* a single run, so `mergedDuplicate` across
 * the suite understates what a long-lived store would merge. `--memory=accumulate`
 * measures that instead, at the cost of order-dependent scores. Either way the
 * per-run `recalledFacts` count is recorded, so contamination is a number in the
 * results rather than an assumption in a README.
 */
export class MemoryProbe {
  constructor(
    private readonly facts: MemoryRepository,
    private readonly mode: 'reset' | 'accumulate',
  ) {}

  static from(app: INestApplicationContext, mode: 'reset' | 'accumulate'): MemoryProbe {
    return new MemoryProbe(app.get<MemoryRepository>(MEMORY_REPOSITORY), mode);
  }

  async before(): Promise<MemoryFunnel> {
    if (this.mode === 'reset') await this.clear();
    return this.facts.funnel();
  }

  async after(before: MemoryFunnel, recalledFacts: number): Promise<MemoryActivity> {
    const now = await this.facts.funnel();
    if (this.mode === 'reset') await this.clear();

    return {
      skippedNoSelfReference: now.skippedNoSelfReference - before.skippedNoSelfReference,
      proposed: now.proposed - before.proposed,
      droppedLowImportance: now.droppedLowImportance - before.droppedLowImportance,
      mergedDuplicate: now.mergedDuplicate - before.mergedDuplicate,
      stored: now.stored - before.stored,
      recalledFacts,
    };
  }

  private async clear(): Promise<void> {
    const all = await this.facts.all();
    if (all.length > 0) await this.facts.delete(all.map((fact) => fact.id));
  }
}

/** Long-term facts injected into this run — `session_turn` refs are short-term. */
function countRecalledFacts(events: EmittedAgentEvent[]): number {
  return events
    .filter((event) => event.type === 'memory_read')
    .flatMap((event) => event.refs)
    .filter((ref) => ref.kind !== 'session_turn').length;
}

/**
 * Tool names the run tried to call that the registry does not hold.
 *
 * Read off `tool_finished.error` rather than off graph state, because a
 * sub-question's `status: 'failed'` never leaves the graph — the same asymmetry
 * the event's own comment documents. It is the observable half of §7's "forbidden
 * tool call attempted?": the registry makes such a call unreachable, so what
 * remains to measure is the attempt.
 */
function unknownToolCalls(events: EmittedAgentEvent[]): string[] {
  const attempted = events
    .filter((event) => event.type === 'tool_finished')
    .filter((event) => event.error?.startsWith('Unknown tool'))
    .map((event) => event.tool);
  return [...new Set(attempted)];
}

/** The live verdicts, narrowed to what the results file keeps. */
export function toGuardrailScores(verdicts: GuardrailVerdict[]): GuardrailScore[] {
  return verdicts.map((verdict) => ({
    name: verdict.name,
    stage: verdict.stage,
    passed: verdict.passed,
    findings: verdict.findings,
  }));
}

/** `run_finished.models` — the providers actually used, which failover makes a list. */
function modelsFrom(events: EmittedAgentEvent[]): string[] {
  for (const event of events) {
    if (event.type === 'run_finished') return event.models ?? [];
  }
  return [];
}

export async function runAgentQuestion(
  app: INestApplicationContext,
  memory: MemoryProbe,
  question: EvalQuestion,
): Promise<EvalRun> {
  const graph = app.get(AgentGraphService);
  const funnelBefore = await memory.before();
  const started = Date.now();

  try {
    const result = await graph.run({ question: question.question });

    const evidence: EvidenceRecord[] = result.state.evidence.map((e) => ({
      evidenceId: e.evidenceId,
      docId: e.docId,
      source: e.source,
      title: e.title,
      distance: e.distance,
      tool: e.tool,
      text: e.text,
    }));

    return {
      questionId: question.id,
      mode: 'agent',
      question: question.question,
      runId: result.runId,
      answerText: result.answer.text,
      abstained: result.answer.abstained,
      citations: result.answer.citations,
      evidence,
      subQuestions: result.state.subQuestions.map((sq) => ({
        id: sq.id,
        text: sq.text,
        tool: sq.tool,
        status: sq.status,
      })),
      hops: extraRetrievalRounds(result.state.subQuestions),
      toolsUsed: [...new Set(result.state.subQuestions.map((sq) => sq.tool))],
      unknownToolCalls: unknownToolCalls(result.events),
      latencyMs: result.latencyMs,
      costUsd: result.costUsd,
      usage: result.usage,
      models: modelsFrom(result.events),
      memory: await memory.after(funnelBefore, countRecalledFacts(result.events)),
      guardrails: toGuardrailScores(result.guardrails),
      error: null,
    };
  } catch (error) {
    // A thrown run is a score of zero, never a skipped question. Dropping it
    // would shrink the denominator and make an unstable agent look accurate.
    return {
      questionId: question.id,
      mode: 'agent',
      question: question.question,
      runId: '',
      answerText: '',
      abstained: false,
      citations: [],
      evidence: [],
      subQuestions: [],
      hops: 0,
      toolsUsed: [],
      unknownToolCalls: [],
      latencyMs: Date.now() - started,
      costUsd: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      models: [],
      memory: await memory.after(funnelBefore, 0),
      guardrails: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

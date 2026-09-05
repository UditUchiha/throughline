import { Injectable, Logger } from '@nestjs/common';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { Evidence, SubQuestion } from '../agent.types';
import { createEmitter, getRunContext } from '../agent-run-context';
import { mintEvidenceId } from '../citations';
import type { AgentState, AgentStateUpdate } from '../state';
import { ToolRegistry } from '../tools/tool-registry';

interface SubQuestionOutcome {
  subQuestion: SubQuestion;
  evidence: Evidence[];
}

/**
 * Runs every pending sub-question, independent ones concurrently.
 *
 * Only `pending` entries are touched, which is what makes the reflect → execute
 * loop safe: a second hop re-enters this node and picks up only the follow-ups.
 */
@Injectable()
export class ExecuteNode {
  private readonly logger = new Logger(ExecuteNode.name);

  constructor(private readonly tools: ToolRegistry) {}

  async run(state: AgentState, config: LangGraphRunnableConfig): Promise<AgentStateUpdate> {
    const { emit, events } = createEmitter(config);
    const { signal } = getRunContext(config);

    const remaining = state.subQuestions.filter((sq) => sq.status === 'pending');
    // A failed dependency still counts as resolved — one dead branch should not
    // strand everything downstream of it.
    const settled = new Set(
      state.subQuestions
        .filter((sq) => sq.status === 'done' || sq.status === 'failed')
        .map((sq) => sq.id),
    );

    const subQuestions: SubQuestion[] = [];
    const evidence: Evidence[] = [];

    while (remaining.length > 0) {
      if (signal.aborted) {
        this.logger.warn(`Agent budget exhausted with ${remaining.length} sub-question(s) pending`);
        for (const sq of remaining) {
          subQuestions.push({ ...sq, status: 'failed', error: 'Agent time budget exhausted' });
        }
        break;
      }

      const ready = remaining.filter((sq) => (sq.dependsOn ?? []).every((id) => settled.has(id)));

      // Nothing ready but work remaining means the dependency graph has a cycle
      // the planner's validation missed. Draining it is strictly better than
      // spinning forever; ordering is an optimisation, not a correctness rule.
      const batch = ready.length > 0 ? ready : remaining.slice();
      if (ready.length === 0) {
        this.logger.warn('Unsatisfiable sub-question dependencies; running remaining in parallel');
      }

      const outcomes = await Promise.all(batch.map((sq) => this.runOne(sq, emit, signal)));

      for (const outcome of outcomes) {
        subQuestions.push(outcome.subQuestion);
        evidence.push(...outcome.evidence);
        settled.add(outcome.subQuestion.id);
        remaining.splice(
          remaining.findIndex((sq) => sq.id === outcome.subQuestion.id),
          1,
        );
      }
    }

    return { subQuestions, evidence, events };
  }

  private async runOne(
    subQuestion: SubQuestion,
    emit: ReturnType<typeof createEmitter>['emit'],
    signal: AbortSignal,
  ): Promise<SubQuestionOutcome> {
    const tool = this.tools.get(subQuestion.tool);
    if (!tool) {
      // The planner normalises unknown tool names, so reaching here means a
      // follow-up from `reflect` slipped through.
      const error = `Unknown tool "${subQuestion.tool}"`;

      // Emitted even though nothing ran: `reflect_done` already announced this
      // sub-question as pending, and staying silent would leave it pending in a
      // consumer forever. The pair is what says "dispatched, and it failed".
      emit({
        type: 'tool_started',
        subQuestionId: subQuestion.id,
        tool: subQuestion.tool,
        input: subQuestion.text,
      });
      emit({
        type: 'tool_finished',
        subQuestionId: subQuestion.id,
        tool: subQuestion.tool,
        evidenceIds: [],
        latencyMs: 0,
        error,
      });

      return {
        subQuestion: { ...subQuestion, status: 'failed', error },
        evidence: [],
      };
    }

    emit({
      type: 'tool_started',
      subQuestionId: subQuestion.id,
      tool: tool.name,
      input: subQuestion.text,
    });

    const start = Date.now();

    try {
      const chunks = await tool.execute({ query: subQuestion.text, signal });
      const evidence: Evidence[] = chunks.map((chunk) => ({
        evidenceId: mintEvidenceId(chunk.chunkId),
        docId: chunk.docId,
        source: chunk.source,
        title: chunk.articleTitle,
        text: chunk.text,
        distance: chunk.distance,
        retrievedBy: subQuestion.id,
        tool: tool.name,
      }));

      emit({
        type: 'tool_finished',
        subQuestionId: subQuestion.id,
        tool: tool.name,
        evidenceIds: evidence.map((e) => e.evidenceId),
        latencyMs: Date.now() - start,
      });

      if (evidence.length > 0) {
        emit({ type: 'evidence_added', evidence });
      }

      return { subQuestion: { ...subQuestion, status: 'done' }, evidence };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Tool ${tool.name} failed for ${subQuestion.id}: ${message}`);

      emit({
        type: 'tool_finished',
        subQuestionId: subQuestion.id,
        tool: tool.name,
        evidenceIds: [],
        latencyMs: Date.now() - start,
        // The failure has to travel with the event. `status: 'failed'` below only
        // ever reaches graph state — `plan_created` and `reflect_done` are emitted
        // before execution — so this is a consumer's only signal that the empty
        // `evidenceIds` means "threw" rather than "found nothing".
        error: message,
      });

      return {
        subQuestion: { ...subQuestion, status: 'failed', error: message },
        evidence: [],
      };
    }
  }
}

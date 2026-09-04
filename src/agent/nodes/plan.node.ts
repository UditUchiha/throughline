import { Inject, Injectable, Logger } from '@nestjs/common';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { LLM_SERVICE } from '../../ai/llm/llm.constants';
import type { LlmService } from '../../ai/llm/llm.types';
import { AppConfigService } from '../../config/app-config.service';
import type { SubQuestion } from '../agent.types';
import { createEmitter, getRunContext, recordUsage } from '../agent-run-context';
import type { AgentState, AgentStateUpdate } from '../state';
import { parseJsonObject } from '../structured-output';
import { ToolRegistry } from '../tools/tool-registry';

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    subQuestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Short identifier, e.g. "sq1".' },
          text: { type: 'string', description: 'A self-contained question to search for.' },
          tool: { type: 'string', description: 'Name of the tool that should answer it.' },
          dependsOn: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids that must be answered first. Empty unless genuinely sequential.',
          },
        },
        required: ['id', 'text', 'tool', 'dependsOn'],
        additionalProperties: false,
      },
    },
  },
  required: ['subQuestions'],
  additionalProperties: false,
};

interface PlanResponse {
  subQuestions: { id: string; text: string; tool: string; dependsOn?: string[] }[];
}

/**
 * Decomposes a complex question into independently searchable sub-questions.
 *
 * The tool menu is injected from the registry at prompt-build time, so adding a
 * tool never means editing this node (PLAN.md §5, M1.3).
 */
@Injectable()
export class PlanNode {
  private readonly logger = new Logger(PlanNode.name);

  constructor(
    @Inject(LLM_SERVICE) private readonly llm: LlmService,
    private readonly tools: ToolRegistry,
    private readonly config: AppConfigService,
  ) {}

  async run(state: AgentState, config: LangGraphRunnableConfig): Promise<AgentStateUpdate> {
    const { emit, events } = createEmitter(config);
    const { signal } = getRunContext(config);
    const maxFanOut = this.config.maxFanOut;

    const system = `You plan retrieval for a system searching a company's email, chat and meeting notes.

Break the user's question into 2 to ${maxFanOut} sub-questions. Each sub-question must be
self-contained — it will be run as a standalone search, with no knowledge of the others or of
the original question.

Search targets you may name in your JSON output. These are labels to choose between, not
functions to call — never emit a tool call, only JSON:
${this.tools.describeForPlanner()}

Rules:
- Assign each sub-question the single target most likely to hold that evidence.
- Leave "dependsOn" empty unless a sub-question genuinely cannot be phrased without the answer
  to another. Independent sub-questions run in parallel, so needless dependencies cost latency.
- Do not invent target names. Use only the names listed above.
Reply with JSON only.`;

    const result = await this.llm.chat([{ role: 'user', content: state.question }], {
      system,
      tier: 'fast',
      jsonSchema: RESPONSE_SCHEMA,
      signal,
    });

    recordUsage(config, result);

    const parsed = parseJsonObject<PlanResponse>(result.text);
    const subQuestions = this.normalise(parsed?.subQuestions ?? [], state.question, maxFanOut);

    emit({ type: 'plan_created', subQuestions });
    return { subQuestions, events };
  }

  /**
   * The planner is an LLM, so its output is a proposal, not a contract: it can
   * exceed the fan-out cap, name a tool that does not exist, or point
   * `dependsOn` at an id it never created. Each of those is repaired here rather
   * than failing the run — a slightly worse plan still answers the question,
   * whereas a thrown error answers nothing.
   */
  private normalise(
    proposed: PlanResponse['subQuestions'],
    question: string,
    maxFanOut: number,
  ): SubQuestion[] {
    const fallbackTool = this.tools.defaultToolName();

    if (proposed.length === 0) {
      this.logger.warn('Planner returned no sub-questions; falling back to a single broad search');
      return [{ id: 'sq1', text: question, tool: fallbackTool, status: 'pending', hop: 0 }];
    }

    const capped = proposed.slice(0, maxFanOut);

    // Ids are assigned in their own pass so `dependsOn` can be checked against the
    // final set. Two sub-questions sharing an id would silently collapse in the
    // merge-by-id state reducer, leaving `plan_created` advertising work that
    // never runs.
    const ids = new Set<string>();
    const assignedIds = capped.map((sq, i) => {
      let id = sq.id?.trim() || `sq${i + 1}`;
      if (ids.has(id)) {
        let n = capped.length;
        do {
          n += 1;
          id = `sq${n}`;
        } while (ids.has(id));
        this.logger.warn(`Planner reused sub-question id "${sq.id}"; renamed to "${id}"`);
      }
      ids.add(id);
      return id;
    });

    return capped.map((sq, i) => {
      const id = assignedIds[i];
      const tool = this.tools.has(sq.tool) ? sq.tool : fallbackTool;
      if (tool !== sq.tool) {
        this.logger.warn(`Planner named unknown tool "${sq.tool}"; using ${fallbackTool}`);
      }

      // Self-references and dangling ids would deadlock the dependency drain.
      const dependsOn = (sq.dependsOn ?? []).filter((dep) => dep !== id && ids.has(dep));

      return {
        id,
        text: sq.text || question,
        tool,
        status: 'pending' as const,
        hop: 0,
        ...(dependsOn.length > 0 ? { dependsOn } : {}),
      };
    });
  }
}

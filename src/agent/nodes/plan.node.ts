import { Inject, Injectable, Logger } from '@nestjs/common';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { z } from 'zod';
import { LLM_SERVICE } from '../../ai/llm/llm.constants';
import type { LlmService } from '../../ai/llm/llm.types';
import { AppConfigService } from '../../config/app-config.service';
import type { SubQuestion } from '../agent.types';
import { createEmitter, getRunContext, recordUsage } from '../agent-run-context';
import { renderMemoryBlock } from '../memory-context';
import type { AgentState, AgentStateUpdate } from '../state';
import { parseJsonObject } from '../structured-output';
import { ToolRegistry } from '../tools/tool-registry';

/**
 * Id of the verbatim-question search. Reserved rather than generated so it is
 * recognisable in a trace and cannot collide with a planner-proposed id.
 */
const BREADTH_QUERY_ID = 'sq0';

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

/**
 * The response shape, checked. `normalise` below calls `.slice()` and `.map()`
 * on `subQuestions`, so a model that answered `{"subQuestions": "sq1, sq2"}`
 * used to reach `.map is not a function` and fail the run — a string has a
 * `length` and a `slice`, so it survives every guard until the last one.
 *
 * Every field is optional because `normalise` already supplies a default for
 * each: a missing `id` becomes `sq{n}`, a missing `text` becomes the question, an
 * unknown `tool` becomes the default tool. The schema's job is to stop a *wrong
 * type* getting that far, not to re-impose requirements the node handles better.
 *
 * `.catch([])` on the array is the same bargain one level up: a `subQuestions`
 * that is not a list of objects degrades to no plan, which is the node's
 * documented "planner returned no sub-questions" path — a single broad search
 * rather than a failed run.
 */
const planResponseSchema = z.object({
  subQuestions: z
    .array(
      z.object({
        id: z.string().optional(),
        text: z.string().optional(),
        tool: z.string().optional(),
        dependsOn: z.array(z.string()).optional(),
      }),
    )
    .catch([]),
});

type PlanResponse = z.infer<typeof planResponseSchema>;

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

    const result = await this.llm.chat([{ role: 'user', content: this.renderUser(state) }], {
      system,
      tier: 'fast',
      jsonSchema: RESPONSE_SCHEMA,
      signal,
    });

    recordUsage(config, result);

    const parsed = parseJsonObject(result.text, planResponseSchema);
    const subQuestions = this.normalise(parsed?.subQuestions ?? [], state.question, maxFanOut);

    emit({ type: 'plan_created', subQuestions });
    return { subQuestions, events };
  }

  /**
   * The question, plus anything long-term memory recalled about the person
   * asking (PLAN.md §5/M4.2 — "inject the top few into planner context").
   *
   * Framed as background rather than as part of the question, and explicitly
   * fallible: a remembered fact should widen where the planner looks — someone
   * who works on Helios asking "did it ship?" means Helios — but a stale or
   * wrong one must not become a sub-question of its own.
   */
  private renderUser(state: AgentState): string {
    const memory = renderMemoryBlock(state.memoryUsed);
    if (!memory) return state.question;

    return [
      `Question: ${state.question}`,
      '',
      'Background remembered about the person asking, from earlier conversations. Use it only',
      'to disambiguate what they are asking about. It may be out of date, it is not part of the',
      'question, and it is never something to go and search for on its own:',
      memory,
    ].join('\n');
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

    // One slot is reserved for the question as asked — see `breadthQuery` below —
    // so the total number of searches still respects MAX_FAN_OUT.
    const capped = proposed.slice(0, Math.max(maxFanOut - 1, 0));

    // Ids are assigned in their own pass so `dependsOn` can be checked against the
    // final set. Two sub-questions sharing an id would silently collapse in the
    // merge-by-id state reducer, leaving `plan_created` advertising work that
    // never runs. Seeded with the reserved id so a planner that proposes "sq0"
    // cannot collide with it.
    const ids = new Set<string>([BREADTH_QUERY_ID]);
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

    const decomposed = capped.map((sq, i) => {
      const id = assignedIds[i];
      // `sq.tool` is now honestly optional, so the missing case is handled where
      // the unknown case already was rather than reaching `tools.has(undefined)`.
      const tool = sq.tool && this.tools.has(sq.tool) ? sq.tool : fallbackTool;
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

    return [this.breadthQuery(question, fallbackTool), ...decomposed];
  }

  /**
   * The question as asked, searched verbatim alongside the decomposition.
   *
   * Measured, not guessed. The 2026-10-04 pass scored the agent *below* a
   * single-shot control on recall@k — 90.5% against 100% — and the misses were
   * almost all `1/2`: one of two required documents found. Decomposition is what
   * costs them. A sub-question is rephrased to stand alone ("who owns the billing
   * migration?"), which moves it away from the language of the document holding
   * the other half, and each narrow query spends its own TOP_K on its own
   * neighbourhood. The undecomposed question sits between the two documents and
   * retrieves both, which is exactly why the control won.
   *
   * So this is not a fallback for a failed plan — `normalise` already has one of
   * those above. It is breadth kept *beside* precision: the decomposition still
   * runs and still earns its hops, and the evidence sets merge. It costs one
   * search per run, taken out of the fan-out budget rather than added to it.
   */
  private breadthQuery(question: string, tool: string): SubQuestion {
    return { id: BREADTH_QUERY_ID, text: question, tool, status: 'pending', hop: 0 };
  }
}

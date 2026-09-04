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
    gapFound: { type: 'boolean' },
    reasoning: { type: 'string' },
    followUps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          tool: { type: 'string' },
        },
        required: ['text', 'tool'],
        additionalProperties: false,
      },
    },
  },
  required: ['gapFound', 'reasoning', 'followUps'],
  additionalProperties: false,
};

interface ReflectResponse {
  gapFound: boolean;
  reasoning: string;
  followUps: { text: string; tool: string }[];
}

/** How much of each passage the reflector sees. Enough to judge coverage, not to answer. */
const EVIDENCE_PREVIEW_CHARS = 400;

/**
 * The multi-hop mechanism: given the evidence so far, does anything material
 * remain unanswered? If so — and the hop budget allows — emit follow-up
 * sub-questions and loop back to `execute`.
 */
@Injectable()
export class ReflectNode {
  private readonly logger = new Logger(ReflectNode.name);

  constructor(
    @Inject(LLM_SERVICE) private readonly llm: LlmService,
    private readonly tools: ToolRegistry,
    private readonly config: AppConfigService,
  ) {}

  async run(state: AgentState, config: LangGraphRunnableConfig): Promise<AgentStateUpdate> {
    const { emit, events } = createEmitter(config);
    const { signal } = getRunContext(config);
    const nextHop = state.hops + 1;

    // Asking "is anything missing?" when we could not act on the answer burns a
    // model call for nothing, so the budget is checked before the call, not after.
    if (nextHop > this.config.maxHops || signal.aborted) {
      emit({ type: 'reflect_done', gapFound: false, followUps: [] });
      return { hops: nextHop, events };
    }

    const system = `You review whether retrieved evidence is sufficient to answer a question.

Available tools for follow-up searches:
${this.tools.describeForPlanner()}

Say a gap exists only when a *material* part of the question is still unsupported — a missing
date, a missing decision, a named person whose role is unexplained. Do not ask for follow-ups
to add colour, corroboration, or background. Returning gapFound=false is the common, correct
answer; an unnecessary extra hop costs the user several seconds.

If evidence genuinely shows the answer is not present in these sources at all, that is not a
gap either — it is an answer, and the next stage will say so.

Propose at most 2 follow-ups. Use only the tool names listed above. Reply with JSON only.`;

    const user = [
      `Question: ${state.question}`,
      '',
      'Evidence gathered so far:',
      this.summariseEvidence(state),
      '',
      'Sub-questions already searched:',
      state.subQuestions.map((sq) => `- [${sq.status}] (${sq.tool}) ${sq.text}`).join('\n') ||
        '- none',
    ].join('\n');

    const result = await this.llm.chat([{ role: 'user', content: user }], {
      system,
      tier: 'fast',
      jsonSchema: RESPONSE_SCHEMA,
      signal,
    });

    recordUsage(config, result);

    const parsed = parseJsonObject<ReflectResponse>(result.text);
    if (!parsed) {
      this.logger.warn(`Unparseable reflect response, proceeding to synthesis: ${result.text}`);
      emit({ type: 'reflect_done', gapFound: false, followUps: [] });
      return { hops: nextHop, events };
    }

    const followUps = this.toSubQuestions(parsed.followUps ?? [], state, nextHop);
    // A claimed gap with no usable follow-up is not actionable — treat it as no gap
    // rather than looping back to `execute` with nothing pending.
    const gapFound = parsed.gapFound && followUps.length > 0;

    emit({ type: 'reflect_done', gapFound, followUps });
    return { hops: nextHop, subQuestions: followUps, events };
  }

  private summariseEvidence(state: AgentState): string {
    if (state.evidence.length === 0) return '- none';
    return state.evidence
      .map((e, i) => {
        const origin = [e.source, e.docId].filter(Boolean).join(' · ') || 'unknown';
        return `${i + 1}. (${origin}) ${e.text.slice(0, EVIDENCE_PREVIEW_CHARS)}`;
      })
      .join('\n');
  }

  private toSubQuestions(
    followUps: ReflectResponse['followUps'],
    state: AgentState,
    hop: number,
  ): SubQuestion[] {
    // Ids must not collide with anything already in state. The planner preserves
    // whatever ids the model returned, so they are not guaranteed to be a dense
    // sq1..sqN: a plan of {sq1, sq3} has length 2, and naming a follow-up by
    // length+1 would mint "sq3" again. The merge-by-id reducer would then
    // overwrite the *completed* sq3, flipping it back to pending so `execute`
    // re-runs it and its result is lost.
    const taken = new Set(state.subQuestions.map((sq) => sq.id));
    let counter = state.subQuestions.length;
    const nextId = (): string => {
      let id: string;
      do {
        counter += 1;
        id = `sq${counter}`;
      } while (taken.has(id));
      taken.add(id);
      return id;
    };

    return followUps
      .filter((followUp) => followUp.text?.trim())
      .slice(0, 2)
      .map((followUp) => ({
        id: nextId(),
        text: followUp.text,
        tool: this.tools.has(followUp.tool) ? followUp.tool : this.tools.defaultToolName(),
        status: 'pending' as const,
        hop,
      }));
  }
}

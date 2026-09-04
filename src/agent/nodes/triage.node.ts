import { Inject, Injectable, Logger } from '@nestjs/common';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { LLM_SERVICE } from '../../ai/llm/llm.constants';
import type { LlmService } from '../../ai/llm/llm.types';
import type { Complexity, SubQuestion } from '../agent.types';
import { createEmitter, getRunContext, recordUsage } from '../agent-run-context';
import type { AgentState, AgentStateUpdate } from '../state';
import { parseJsonObject } from '../structured-output';
import { ToolRegistry } from '../tools/tool-registry';

const SYSTEM_PROMPT = `You triage questions for a retrieval system searching a company's email, chat and meeting notes.

Classify the question as:
- "simple": a single search would surface the answer. One fact, one event, one document.
- "complex": answering requires combining evidence from more than one place — comparing what
  was said in different sources, tracing how a decision changed over time, or resolving who
  did what and why across several conversations.

Prefer "simple" when in doubt. Decomposing a simple question wastes time and money.
Reply with JSON only.`;

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    complexity: { type: 'string', enum: ['simple', 'complex'] },
    reasoning: { type: 'string', description: 'One sentence explaining the classification.' },
  },
  required: ['complexity', 'reasoning'],
  additionalProperties: false,
};

interface TriageResponse {
  complexity: Complexity;
  reasoning: string;
}

/**
 * Decides whether the question needs decomposition at all.
 *
 * A `simple` verdict skips `plan` entirely and goes straight to one retrieval.
 * This is a feature rather than a shortcut: it demonstrates the agent knows when
 * not to be agentic, and the latency/cost delta is a number M6 reports.
 */
@Injectable()
export class TriageNode {
  private readonly logger = new Logger(TriageNode.name);

  constructor(
    @Inject(LLM_SERVICE) private readonly llm: LlmService,
    private readonly tools: ToolRegistry,
  ) {}

  async run(state: AgentState, config: LangGraphRunnableConfig): Promise<AgentStateUpdate> {
    const { emit, events } = createEmitter(config);
    const { signal } = getRunContext(config);

    const result = await this.llm.chat([{ role: 'user', content: state.question }], {
      system: SYSTEM_PROMPT,
      tier: 'fast',
      jsonSchema: RESPONSE_SCHEMA,
      signal,
    });

    recordUsage(config, result);

    const parsed = parseJsonObject<TriageResponse>(result.text);
    const complexity: Complexity = parsed?.complexity === 'simple' ? 'simple' : 'complex';
    const reasoning = parsed?.reasoning ?? 'Triage response could not be parsed; assuming complex.';

    if (!parsed) {
      this.logger.warn(`Unparseable triage response, defaulting to complex: ${result.text}`);
    }

    emit({ type: 'triage_done', complexity, reasoning });

    // A simple question still needs *something* for `execute` to run, so triage
    // seeds the one broad retrieval itself. This keeps `execute` unaware of
    // which branch it is on.
    const subQuestions: SubQuestion[] =
      complexity === 'simple'
        ? [
            {
              id: 'sq1',
              text: state.question,
              tool: this.tools.defaultToolName(),
              status: 'pending',
              hop: 0,
            },
          ]
        : [];

    return { complexity, subQuestions, events };
  }
}

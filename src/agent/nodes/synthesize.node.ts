import { Inject, Injectable, Logger } from '@nestjs/common';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { LLM_SERVICE } from '../../ai/llm/llm.constants';
import type { LlmService } from '../../ai/llm/llm.types';
import type { AgentAnswer, Evidence } from '../agent.types';
import { createEmitter, getRunContext, recordUsage } from '../agent-run-context';
import { renderEvidenceBlock, resolveCitations, stripUnresolvedMarkers } from '../citations';
import type { AgentState, AgentStateUpdate } from '../state';
import { parseJsonObject } from '../structured-output';

/**
 * Upper bound on passages sent to synthesis. Beyond this the prompt grows past
 * what a free-tier context window handles comfortably and the weakest evidence
 * starts crowding out the strongest, so keep the closest matches and drop the tail.
 */
const MAX_EVIDENCE_FOR_SYNTHESIS = 12;

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    abstained: {
      type: 'boolean',
      description: 'True when the sources do not support an answer.',
    },
  },
  required: ['answer', 'abstained'],
  additionalProperties: false,
};

interface SynthesisResponse {
  answer: string;
  abstained: boolean;
}

const ABSTENTION_TEXT = 'I could not find this in the available sources.';

/**
 * Produces the final cited answer.
 *
 * The model is shown numbered passages and cites `[n]`; it never sees an
 * `evidenceId`. Mapping markers back to evidence therefore cannot be faked, and
 * a marker outside the range it was shown is caught here rather than surfacing
 * as a dead link in the UI.
 */
@Injectable()
export class SynthesizeNode {
  private readonly logger = new Logger(SynthesizeNode.name);

  constructor(@Inject(LLM_SERVICE) private readonly llm: LlmService) {}

  async run(state: AgentState, config: LangGraphRunnableConfig): Promise<AgentStateUpdate> {
    const { emit, events } = createEmitter(config);
    const { signal } = getRunContext(config);

    const evidence = this.selectEvidence(state.evidence);

    if (evidence.length === 0) {
      const answer: AgentAnswer = { text: ABSTENTION_TEXT, citations: [], abstained: true };
      return { answer, events };
    }

    const { text: evidenceBlock, ordering } = renderEvidenceBlock(evidence);

    const system = `You answer questions using only the numbered passages provided.

Rules:
- Every factual sentence must end with one or more citation markers like [1] or [2][5].
- Cite only the numbers you were given. Never invent a number.
- If the passages do not support an answer, set "abstained" to true and say
  "${ABSTENTION_TEXT}" — optionally noting what you did find. Abstaining when the evidence is
  absent is correct behaviour, not a failure; a confident wrong answer is far worse.
- Do not add background knowledge of your own. The passages are the only source of truth.
- Be direct. Two or three sentences is usually enough.
Reply with JSON only.`;

    const user = `Question: ${state.question}\n\nPassages:\n${evidenceBlock}`;

    const result = await this.llm.chat([{ role: 'user', content: user }], {
      system,
      tier: 'default',
      jsonSchema: RESPONSE_SCHEMA,
      signal,
    });

    recordUsage(config, result);

    const parsed = parseJsonObject<SynthesisResponse>(result.text);
    // An unparseable synthesis is not recoverable the way an unparseable plan is
    // — there is no safe default answer, so abstain rather than guess.
    if (!parsed?.answer) {
      this.logger.warn(`Unparseable synthesis response: ${result.text}`);
      const answer: AgentAnswer = { text: ABSTENTION_TEXT, citations: [], abstained: true };
      return { answer, events };
    }

    const { citations, unresolved } = resolveCitations(parsed.answer, ordering);
    if (unresolved.length > 0) {
      this.logger.warn(`Synthesis cited non-existent evidence markers: ${unresolved.join(', ')}`);
    }

    const text = stripUnresolvedMarkers(parsed.answer, unresolved).trim();

    // Streaming synthesis token-by-token needs `LlmService.chatStream`, which
    // lands with the SSE surface in M1.4. Emitting the finished text as one
    // delta keeps the event contract honest for consumers in the meantime.
    emit({ type: 'token_delta', text });

    const answer: AgentAnswer = { text, citations, abstained: parsed.abstained === true };
    return { answer, events };
  }

  /** Closest matches first — sqlite-vec distance is ascending-good. */
  private selectEvidence(evidence: Evidence[]): Evidence[] {
    return [...evidence]
      .sort((a, b) => a.distance - b.distance)
      .slice(0, MAX_EVIDENCE_FOR_SYNTHESIS);
  }
}

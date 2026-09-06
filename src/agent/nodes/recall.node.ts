import { Inject, Injectable, Logger } from '@nestjs/common';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { LLM_SERVICE } from '../../ai/llm/llm.constants';
import type { LlmService } from '../../ai/llm/llm.types';
import { LongTermMemoryService } from '../../memory/long-term-memory.service';
import type { MemoryFact } from '../../memory/memory.types';
import type { MemoryRef, SessionTurn } from '../agent.types';
import { createEmitter, getRunContext, recordUsage } from '../agent-run-context';
import { SESSION_TURN_KIND } from '../memory-context';
import type { AgentState, AgentStateUpdate } from '../state';
import { parseJsonObject } from '../structured-output';

/** How much of a recalled answer the resolver — and the memory panel — sees. */
const ANSWER_PREVIEW_CHARS = 320;

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    standalone: {
      type: 'string',
      description: 'The question rewritten so it can be understood on its own.',
    },
    isFollowUp: {
      type: 'boolean',
      description: 'True only if the question depended on the earlier turns.',
    },
  },
  required: ['standalone', 'isFollowUp'],
  additionalProperties: false,
};

interface RecallResponse {
  standalone: string;
  isFollowUp: boolean;
}

const SYSTEM_PROMPT = `You rewrite follow-up questions so a search system can answer them without the conversation.

You are given the earlier turns of a conversation and the visitor's latest question. Replace
pronouns and elliptical references ("it", "that decision", "he", "the same project", "why?")
with the specific thing they refer to, taken from the earlier turns.

Rules:
- Change as little as possible. Substituting a referent is the whole job; do not add detail,
  do not merge in the previous question, and do not answer anything.
- If the latest question already stands on its own, return it unchanged and set
  isFollowUp to false. That is the common case and it is not a failure.
- Never invent a referent the earlier turns do not contain. If nothing there resolves the
  reference, return the question unchanged with isFollowUp false.
Reply with JSON only.`;

/**
 * The one place a run reads memory (PLAN.md §5/M4.1 and §5/M4.2).
 *
 * It does two jobs, in this order, because the second depends on the first:
 *
 * 1. **Short-term** — resolves the question against the session's earlier turns,
 *    so "who approved it?" becomes something a search can answer.
 * 2. **Long-term** — semantically searches durable facts for the *resolved*
 *    question and puts the closest few into `memoryUsed`, where `plan` and
 *    `synthesize` pick them up.
 *
 * Searching long-term memory with the raw follow-up would embed the pronoun and
 * match nothing, which is why the order is not the other way round.
 *
 * §5/M4.2 places long-term retrieval "before `plan`". It happens here, which is
 * before `plan` *and* before `triage` — and that matters, because `triage` can
 * route a simple question straight past the planner. Retrieval sitting inside
 * `plan` would mean a remembered preference never reaches a simple question,
 * which is most of them.
 */
@Injectable()
export class RecallNode {
  private readonly logger = new Logger(RecallNode.name);

  constructor(
    @Inject(LLM_SERVICE) private readonly llm: LlmService,
    private readonly memory: LongTermMemoryService,
  ) {}

  async run(state: AgentState, config: LangGraphRunnableConfig): Promise<AgentStateUpdate> {
    const { emit, events } = createEmitter(config);
    const { signal } = getRunContext(config);

    const turnRefs = state.turns.map(toTurnRef);
    const resolved = await this.resolveAgainstSession(state, config, signal);
    const question = resolved ?? state.question;

    const facts = await this.recallFacts(question, signal);
    const refs = [...turnRefs, ...facts.map(toFactRef)];

    // Nothing recalled and nothing rewritten: a first turn on a clean install.
    // Returning an empty update rather than an empty `memory_read` keeps the
    // event meaning "memory contributed this", not "memory was consulted".
    if (refs.length === 0 && resolved === null) return {};

    if (refs.length > 0) emit({ type: 'memory_read', refs });
    if (resolved !== null) emit({ type: 'followup_resolved', original: state.question, resolved });

    return {
      // Overwrites `question` for every node downstream; `askedQuestion` keeps
      // what the visitor typed, which is what the turn record and the UI show.
      ...(resolved === null ? {} : { question: resolved }),
      memoryUsed: refs,
      events,
    };
  }

  /** Long-term facts, or none — never a reason for the run to fail. */
  private async recallFacts(question: string, signal?: AbortSignal): Promise<MemoryFact[]> {
    try {
      return await this.memory.recall(question, signal);
    } catch (error) {
      // An empty store costs no network call, so reaching here means the
      // embedding provider is refusing — which the retrieval tools are about to
      // discover anyway. Answering without memory beats not answering.
      this.logger.warn(
        `Long-term memory recall failed, continuing without it: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  /**
   * The resolved question, or `null` when it should be left exactly as asked.
   *
   * Returns early with no model call when the session has no history — the first
   * question of a session, which is most questions. A call there could only echo
   * its input back, and on a free tier measured in tens of requests per minute
   * that is worth avoiding.
   */
  private async resolveAgainstSession(
    state: AgentState,
    config: LangGraphRunnableConfig,
    signal: AbortSignal,
  ): Promise<string | null> {
    if (state.turns.length === 0) return null;

    const user = [
      'Earlier turns in this conversation:',
      state.turns.map(describeTurn).join('\n\n'),
      '',
      `Latest question: ${state.question}`,
    ].join('\n');

    const result = await this.llm.chat([{ role: 'user', content: user }], {
      system: SYSTEM_PROMPT,
      tier: 'fast',
      jsonSchema: RESPONSE_SCHEMA,
      signal,
    });

    recordUsage(config, result);

    const parsed = parseJsonObject<RecallResponse>(result.text);
    if (!parsed) {
      // Unlike a failed plan there is a correct fallback here: the question as
      // asked. A run answering the literal question is a worse answer, not a
      // broken one, so this degrades instead of failing.
      this.logger.warn(`Unparseable recall response, using the question as asked: ${result.text}`);
      return null;
    }

    const standalone = parsed.standalone?.trim();
    if (!parsed.isFollowUp || !standalone || standalone === state.question) return null;

    // A "rewrite" that dropped most of the question is the model summarising
    // rather than substituting a referent, and it would silently narrow what the
    // run searches for. Resolving a pronoun can only make a question longer.
    if (standalone.length < state.question.length) {
      this.logger.warn(
        `Discarding a recall rewrite shorter than the question asked: "${standalone}"`,
      );
      return null;
    }

    return standalone;
  }
}

function describeTurn(turn: SessionTurn): string {
  const asked = turn.standalone ?? turn.question;
  return `Q: ${asked}\nA: ${preview(turn.answer)}`;
}

function toTurnRef(turn: SessionTurn, index: number): MemoryRef {
  return {
    // Positional rather than random so the same recalled turn keeps its identity
    // across the run — the UI keys list items by this.
    id: `turn-${index + 1}`,
    kind: SESSION_TURN_KIND,
    text: `${turn.standalone ?? turn.question} — ${preview(turn.answer)}`,
  };
}

function toFactRef(fact: MemoryFact): MemoryRef {
  return { id: `fact-${fact.id}`, kind: fact.kind, text: fact.text };
}

function preview(text: string): string {
  return text.length <= ANSWER_PREVIEW_CHARS ? text : `${text.slice(0, ANSWER_PREVIEW_CHARS)}…`;
}

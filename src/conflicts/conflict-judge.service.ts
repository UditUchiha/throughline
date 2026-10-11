import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { LLM_SERVICE } from '../ai/llm/llm.constants';
import type { LlmService } from '../ai/llm/llm.types';
import { parseJsonObject } from '../agent/structured-output';
import { wrapUntrusted } from '../agent/untrusted-content';
import { CONFLICT_KINDS, isConflictKind } from './conflict.types';
import type { Conflict, ConflictCandidate, ScannedDocument } from './conflict.types';

const SYSTEM_PROMPT = `You audit a company's knowledge base for claims that have stopped being true.

You are given one PRIMARY document and several RELATED documents that discuss similar
subject matter. Find only the pairs that CANNOT BOTH BE TRUE of the company today.

Apply one test to every candidate pair: would someone who read only the primary document,
today, and acted on it, be wrong? If no, there is no conflict.

That test rules out almost everything:
- Two documents about the same topic that simply say different things about it. Overlap is
  not disagreement.
- A decision being discussed, then made. Deliberation followed by a conclusion is a record
  working correctly, not a contradiction.
- Different facets of one situation — a cause in one document, an owner in another.
- A document describing the past in the past tense. "We launched at $49/seat in 2025" stays
  true forever. It only conflicts if it asserts that price is current.
- Different subjects that resemble each other: two services, two customers, two releases.
  Check that both documents are about the SAME thing before calling it a conflict.

A real conflict is a specific, checkable claim — a price, a date, a status, an owner, a
policy — that one document asserts and another replaces or denies.

Classify each as:
- "superseded": the evidence establishes which claim is current. Dated statements, an
  explicit decision or approval, or one document referring to the other's claim as the old
  one. Say what established the order in your reasoning.
- "unresolved": they cannot both be true and nothing available says which wins. A human has
  to decide. Do not guess an order to avoid this label.

Quote each claim from its document rather than paraphrasing it; the quote is what a reader
will be shown to check your work.

Most documents conflict with nothing. Returning an empty list is the correct and common
answer. A false conflict costs a person's attention and makes the whole audit untrustworthy,
so report only what you would defend.

Reply with JSON only.`;

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    conflicts: {
      type: 'array',
      description: 'Only genuine conflicts. Empty when the primary document conflicts with none.',
      items: {
        type: 'object',
        properties: {
          relatedDocId: {
            type: 'string',
            description: 'The docId of the related document, copied exactly as given.',
          },
          kind: { type: 'string', enum: [...CONFLICT_KINDS] },
          topic: { type: 'string', description: 'What they disagree about, a short phrase.' },
          primaryClaim: { type: 'string', description: 'Quoted from the primary document.' },
          relatedClaim: { type: 'string', description: 'Quoted from the related document.' },
          primaryIsOutdated: {
            type: 'boolean',
            description: 'True when the primary holds the stale claim. Ignored when unresolved.',
          },
          reasoning: { type: 'string', description: 'Why both cannot hold, and what dated them.' },
        },
        required: [
          'relatedDocId',
          'kind',
          'topic',
          'primaryClaim',
          'relatedClaim',
          'primaryIsOutdated',
          'reasoning',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['conflicts'],
  additionalProperties: false,
};

/**
 * What the model is allowed to have said.
 *
 * Every field is required here, unlike the agent nodes, and the difference is
 * deliberate: a node has a defined fallback for each missing field, whereas a
 * half-formed conflict has none worth showing. A finding missing its quote or
 * its counterpart cannot be checked by the reader, and an unverifiable finding
 * in an audit is worse than a missing one. Individual malformed entries are
 * dropped rather than failing the batch, so one bad element does not discard
 * the good findings beside it.
 */
const conflictEntrySchema = z.object({
  relatedDocId: z.string().min(1),
  kind: z.string().refine(isConflictKind),
  topic: z.string().min(1),
  primaryClaim: z.string().min(1),
  relatedClaim: z.string().min(1),
  primaryIsOutdated: z.boolean(),
  reasoning: z.string().min(1),
});

const conflictResponseSchema = z.object({
  // `.nullable().catch(null)` per element, so a malformed entry becomes a null
  // the caller skips instead of rejecting the whole array. The alternative —
  // failing the batch — discards the well-formed findings that arrived beside
  // it, and a conflict scan is expensive enough per call to be worth salvaging.
  conflicts: z.array(conflictEntrySchema.nullable().catch(null)),
});

/**
 * Decides whether a document and its nearest neighbours contradict each other.
 *
 * One model call per candidate rather than per pair, which is what makes a scan
 * affordable: the corpus yields roughly 500 near-neighbour pairs but only 172
 * documents, and the free tiers this project runs on are measured in tens of
 * calls per window. Batching also gives the model the comparison set at once,
 * so it can see that a claim is repeated in three places rather than meeting
 * each repetition cold.
 *
 * **Document text reaching a model here is untrusted, and more exposed than
 * anywhere else in the system.** The agent only ever sees documents a search
 * retrieved; a scan feeds it every document there is, including the corpus's
 * `adversarial: true` payloads, which exist precisely to be followed. The fence
 * is why the eventual injection reaching the model is quoted data. The
 * structural guarantee is stronger and quieter: this call names no tools and
 * can reach none, so the worst a successful injection achieves is a fabricated
 * finding in a report a human is already reading critically.
 */
@Injectable()
export class ConflictJudge {
  private readonly logger = new Logger(ConflictJudge.name);

  constructor(@Inject(LLM_SERVICE) private readonly llm: LlmService) {}

  async judge(candidate: ConflictCandidate, signal?: AbortSignal): Promise<Conflict[]> {
    if (candidate.neighbours.length === 0) return [];

    const result = await this.llm.chat([{ role: 'user', content: render(candidate) }], {
      system: SYSTEM_PROMPT,
      tier: 'deep',
      jsonSchema: RESPONSE_SCHEMA,
      signal,
    });

    const parsed = parseJsonObject(result.text, conflictResponseSchema);
    if (!parsed) {
      this.logger.warn(`Unparseable conflict verdict for ${candidate.subject.docId}`);
      return [];
    }

    const byDocId = new Map(candidate.neighbours.map((n) => [n.docId, n]));

    return parsed.conflicts.flatMap((entry) => {
      if (!entry) return [];

      // The model is asked to copy a docId back, so it can return one that was
      // never offered — a hallucinated neighbour, or the primary's own id. A
      // conflict whose other side cannot be resolved to a real document is
      // uncitable, and an uncitable finding is exactly what this report must
      // not contain.
      const related = byDocId.get(entry.relatedDocId);
      if (!related) {
        this.logger.warn(
          `Discarded conflict for ${candidate.subject.docId}: "${entry.relatedDocId}" was not among its neighbours`,
        );
        return [];
      }

      const kind = isConflictKind(entry.kind) ? entry.kind : 'unresolved';
      const primarySide = side(candidate.subject, entry.primaryClaim);
      const relatedSide = side(related, entry.relatedClaim);

      // `primaryIsOutdated` only means anything once an order is established.
      // When it is not, the two sides are peers and the field is noise, so the
      // stable ordering is used rather than a flag the model had no basis for.
      const primaryStale = kind === 'superseded' ? entry.primaryIsOutdated : true;

      return [
        {
          kind,
          topic: entry.topic,
          outdated: primaryStale ? primarySide : relatedSide,
          current: primaryStale ? relatedSide : primarySide,
          reasoning: entry.reasoning,
        },
      ];
    });
  }
}

function side(document: ScannedDocument, claim: string) {
  return { docId: document.docId, source: document.source, claim };
}

/**
 * Builds the comparison prompt.
 *
 * Document ids sit *outside* the fence while bodies sit inside it, because the
 * ids are ours — generated at index time — and the model has to copy one back
 * to identify which neighbour it means. Putting them inside would ask the model
 * to both distrust and rely on the same span.
 */
function render(candidate: ConflictCandidate): string {
  const neighbours = candidate.neighbours
    .map(
      (n, i) => `RELATED ${i + 1} — docId: ${n.docId} (source: ${n.source ?? 'unknown'})
${wrapUntrusted(n.text)}`,
    )
    .join('\n\n');

  return `PRIMARY — docId: ${candidate.subject.docId} (source: ${candidate.subject.source ?? 'unknown'})
${wrapUntrusted(candidate.subject.text)}

${neighbours}`;
}

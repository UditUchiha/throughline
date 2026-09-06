import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { LLM_SERVICE } from '../ai/llm/llm.constants';
import type { ChatResult, LlmService } from '../ai/llm/llm.types';
import { EMBEDDING_SERVICE, type EmbeddingProvider } from '../embeddings/embedding.types';
import { MEMORY_REPOSITORY } from '../repositories/ports/tokens';
import type { FactOrigin, MemoryRepository } from '../repositories/ports/memory.repository';
import { parseJsonObject } from '../agent/structured-output';
import { MEMORY_KINDS, type MemoryCandidate, type MemoryFact } from './memory.types';

/** Upper bound on candidates from one run, before scoring. */
const MAX_CANDIDATES_PER_RUN = 3;

/** Longest a fact may be. A "fact" that needs a paragraph is a summary. */
const MAX_FACT_CHARS = 200;

/**
 * Texts per embedding request during consolidation. Facts are capped at
 * {@link MAX_FACT_CHARS}, so 64 of them is a few thousand characters — well
 * inside any provider's input limit, and small enough that a failure costs one
 * batch rather than the whole pass.
 */
const CONSOLIDATION_EMBED_BATCH = 64;

const EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'One durable fact, stated in the third person about the user.',
          },
          kind: { type: 'string', enum: [...MEMORY_KINDS] },
          importance: {
            type: 'number',
            description: '0 to 1. How much this should shape future answers.',
          },
        },
        required: ['text', 'kind', 'importance'],
        additionalProperties: false,
      },
    },
  },
  required: ['facts'],
  additionalProperties: false,
};

interface ExtractionResponse {
  facts: { text?: string; kind?: string; importance?: number }[];
}

const EXTRACTION_PROMPT = `You decide what is worth remembering about a person across future conversations.

You are given one exchange: what the user asked and what the assistant answered. Propose only
facts that would still be true and still be useful weeks from now.

Remember these:
- "preference" — how the user wants to be answered, or what they care about. Stated by them,
  not guessed from one question.
- "relationship" — a durable fact about who the user is or what they work on.
- "correction" — the user telling you something you had wrong. These matter most.

Do NOT remember:
- Anything already in the searchable corpus. The corpus is the source of truth for company
  facts; storing them again is duplication, not memory.
- The question itself, the answer itself, or a summary of either.
- One-off intent ("wants to know who approved it"). Wanting an answer now says nothing about
  what to do later.
- Anything you inferred. If the user did not say it, it is not a fact about them.

Most exchanges contain nothing worth remembering. Returning an empty list is the normal,
correct answer — propose a fact only when you would bet on it still mattering next month.

Score importance honestly: 0.9 for a correction the user made, 0.7 for a preference they
stated outright, 0.3 for something merely implied. Reply with JSON only.`;

/**
 * First-person markers. A question containing none of these says nothing about
 * the person asking, so there is nothing for extraction to act on.
 *
 * Contractions are matched by their stem — `\bi\b` does not match "I'm", so the
 * apostrophe forms are listed. `i` is safe against "API" (both neighbours are
 * word characters, so the boundary fails); it does match the "i" in "i.e.",
 * which costs one unnecessary model call in a rare case. That is the right
 * direction to err: a spurious extraction wastes a call, a missed one loses a
 * fact the visitor volunteered.
 */
const SELF_REFERENCE =
  /\b(?:i|i'm|i've|i'd|i'll|me|my|mine|myself|we|we're|we've|we'd|we'll|us|our|ours|ourselves)\b/i;

/**
 * Whether a question discloses anything about the person asking.
 *
 * **The gate PLAN.md §5/M6.1 left open, closed by measurement.** `remember` costs
 * a `fast` model call on every answered run — roughly a fifth of a run's budget
 * against a free tier of ~20 requests per window — and the extractor's own prompt
 * says most exchanges contain nothing worth remembering. Whether to skip it on a
 * heuristic was deliberately not decided in M4.2, because the deciding number did
 * not exist: "if ~54 of 56 runs propose nothing, the gate is obviously right; if
 * 20 propose something, it is not."
 *
 * M6's full suite measured it. **Across all 59 corpus questions, extraction
 * proposed exactly zero candidates** — 59 model calls, no facts, no exceptions.
 * That is stronger than the threshold the plan set, so the gate is in.
 *
 * It buys two things for one change:
 *
 * 1. **A model call per corpus-style run.** Retrieval questions about a company
 *    are what this system is for, and none of them can produce a durable fact
 *    about the visitor.
 * 2. **It closes most of the injection path that outlives a run.** `remember`
 *    extracts from the question *and the answer*, and an answer derives from
 *    retrieved documents — so an attacker-authored passage could in principle
 *    reach durable memory. Gating on the **question** means document text can no
 *    longer trigger extraction at all: the visitor has to have disclosed
 *    something first. HANDOFF recorded that channel as "narrow but not closed";
 *    it is now closed except where the visitor themselves opens it.
 *
 * The cost is a false negative on self-disclosure phrased without a first-person
 * word, which is rare and loses one fact rather than corrupting anything.
 */
export function mentionsSelf(question: string): boolean {
  return SELF_REFERENCE.test(question);
}

/**
 * The long-term memory funnel: extract → score → deduplicate → store, plus
 * retrieval and consolidation (PLAN.md §5/M4.2).
 *
 * Every stage that discards something increments a counter, because the claim
 * worth making about a memory system is not "it remembers" but *how little* it
 * chooses to keep. An unbounded store is a log.
 *
 * Nothing here throws at its caller. Memory is an enhancement to a run that has
 * already produced its answer, so a failed extraction must cost the run nothing;
 * see {@link LongTermMemoryService.remember}.
 */
@Injectable()
export class LongTermMemoryService {
  private readonly logger = new Logger(LongTermMemoryService.name);

  constructor(
    private readonly config: AppConfigService,
    @Inject(LLM_SERVICE) private readonly llm: LlmService,
    @Inject(EMBEDDING_SERVICE) private readonly embeddings: EmbeddingProvider,
    @Inject(MEMORY_REPOSITORY) private readonly facts: MemoryRepository,
  ) {}

  /**
   * Facts worth putting in front of a run, closest to the question first.
   *
   * Stamps `lastUsedAt` on what it returns — this is the one caller that decides
   * a fact was actually used, which is what keeps decay honest.
   *
   * The distance ceiling is doing two jobs, and neither is optional. `search`
   * returns the k *nearest* facts however far away they are, so without it a
   * store smaller than `MEMORY_TOP_K` handed every fact to every question —
   * including ones about a different subject entirely. And because `markUsed`
   * stamps whatever comes back, every run refreshed every fact, so
   * `forgetStale` never had a candidate and `MEMORY_TTL_DAYS` was dead config.
   * Filtering before the stamp fixes both: a fact only counts as used when it
   * was close enough to actually be used.
   */
  async recall(question: string, signal?: AbortSignal): Promise<MemoryFact[]> {
    if ((await this.facts.countFacts()) === 0) return [];

    const [embedding] = await this.embeddings.embed([question], signal);
    const hits = await this.facts.search(embedding, this.config.memoryTopK);

    const relevant = hits.filter((hit) => hit.distance <= this.config.memoryRecallDistance);
    if (relevant.length === 0) return [];

    const recalled = relevant.map((hit) => hit.fact);
    await this.facts.markUsed(recalled.map((fact) => fact.id));
    return recalled;
  }

  /**
   * Runs the funnel over one finished exchange.
   *
   * Returns the facts that were newly stored *and* the ones a restatement
   * merged into, because both are things the run committed to memory and the
   * `memory_written` event should say so.
   */
  async remember(
    exchange: { question: string; answer: string },
    origin: FactOrigin,
    signal?: AbortSignal,
  ): Promise<{ stored: MemoryFact[]; merged: MemoryFact[] }> {
    try {
      // Before the model call, not after it — the saving *is* the point. Counted
      // so the gate keeps the evidence for itself: see `skippedNoSelfReference`.
      if (!mentionsSelf(exchange.question)) {
        await this.facts.incrementFunnel('skippedNoSelfReference');
        return { stored: [], merged: [] };
      }

      const candidates = await this.extract(exchange, signal);
      if (candidates.length === 0) return { stored: [], merged: [] };

      await this.facts.incrementFunnel('proposed', candidates.length);

      const kept = candidates.filter(
        (candidate) => candidate.importance >= this.config.memoryImportanceFloor,
      );
      const dropped = candidates.length - kept.length;
      if (dropped > 0) await this.facts.incrementFunnel('droppedLowImportance', dropped);
      // Scored out before any embedding call, which is the point of ordering the
      // funnel this way: the cheapest gate runs first.
      if (kept.length === 0) return { stored: [], merged: [] };

      const stored: MemoryFact[] = [];
      const merged: MemoryFact[] = [];

      for (const candidate of kept) {
        const outcome = await this.storeOrMerge(candidate, origin, signal);
        if (outcome.kind === 'stored') stored.push(outcome.fact);
        else if (outcome.kind === 'merged') merged.push(outcome.fact);
      }

      return { stored, merged };
    } catch (error) {
      // The answer is already on the wire. Losing a remembered fact is a worse
      // memory system; failing the run would be a worse product.
      this.logger.warn(
        `Long-term memory extraction failed for run ${origin.runId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return { stored: [], merged: [] };
    }
  }

  /**
   * Merges near-duplicates and forgets what has aged out (PLAN.md §5/M4.2).
   *
   * Deduplication at write time only compares a candidate against what existed
   * *then*. Two facts written a week apart can end up near-duplicates because
   * the threshold was missed by a hair, or because the phrasing drifted — this
   * is the pass that catches those.
   */
  async consolidate(): Promise<{ merged: number; forgotten: number }> {
    const forgotten = await this.forgetStale();
    const merged = await this.mergeNearDuplicates();
    if (merged > 0 || forgotten > 0) {
      this.logger.log(`Memory consolidation: merged=${merged} forgotten=${forgotten}`);
    }
    return { merged, forgotten };
  }

  private async extract(
    exchange: { question: string; answer: string },
    signal?: AbortSignal,
  ): Promise<MemoryCandidate[]> {
    const user = [
      `User asked: ${exchange.question}`,
      '',
      `Assistant answered: ${exchange.answer}`,
    ].join('\n');

    const result = await this.llm.chat([{ role: 'user', content: user }], {
      system: EXTRACTION_PROMPT,
      tier: 'fast',
      jsonSchema: EXTRACTION_SCHEMA,
      signal,
    });

    return this.toCandidates(result);
  }

  private toCandidates(result: ChatResult): MemoryCandidate[] {
    const parsed = parseJsonObject<ExtractionResponse>(result.text);
    if (!parsed) {
      // "Nothing worth remembering" is the correct default here, and it is also
      // what an unparseable response should mean: inventing a fact from a
      // response we could not read is how a memory store fills with noise.
      this.logger.warn(`Unparseable memory extraction, remembering nothing: ${result.text}`);
      return [];
    }

    const candidates: MemoryCandidate[] = [];
    for (const raw of parsed.facts ?? []) {
      const text = raw.text?.trim();
      if (!text || text.length > MAX_FACT_CHARS) continue;
      if (typeof raw.importance !== 'number' || Number.isNaN(raw.importance)) continue;

      const kind = MEMORY_KINDS.find((known) => known === raw.kind);
      if (!kind) continue;

      candidates.push({
        text,
        kind,
        // Clamped rather than trusted: the schema asks for 0..1 and a model that
        // returns 5 would otherwise clear every floor forever.
        importance: Math.min(Math.max(raw.importance, 0), 1),
      });
    }

    return candidates.slice(0, MAX_CANDIDATES_PER_RUN);
  }

  private async storeOrMerge(
    candidate: MemoryCandidate,
    origin: FactOrigin,
    signal?: AbortSignal,
  ): Promise<{ kind: 'stored' | 'merged' | 'skipped'; fact: MemoryFact }> {
    const [embedding] = await this.embeddings.embed([candidate.text], signal);
    const [nearest] = await this.facts.search(embedding, 1);

    if (nearest && nearest.distance <= this.config.memoryDedupDistance) {
      const bumped = await this.facts.recordRestatement(nearest.fact.id);
      if (bumped) {
        await this.facts.incrementFunnel('mergedDuplicate');
        return { kind: 'merged', fact: bumped };
      }
      // The fact was deleted between the search and the update — consolidation
      // running concurrently. Fall through and store it as new.
    }

    const fact = await this.facts.insert(candidate, embedding, origin);
    await this.facts.incrementFunnel('stored');
    return { kind: 'stored', fact };
  }

  private async forgetStale(): Promise<number> {
    const cutoff = new Date(
      Date.now() - this.config.memoryTtlDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const stale = await this.facts.findUnusedSince(cutoff);
    if (stale.length === 0) return 0;

    await this.facts.delete(stale.map((fact) => fact.id));
    return stale.length;
  }

  /**
   * Collapses facts that now sit within the dedup distance of an earlier one.
   *
   * Oldest wins, and the survivor absorbs the loser's `accessCount` by being
   * restated once per merge — so "this was said four times" survives a merge
   * instead of resetting to one.
   */
  /**
   * Embeds a list in fixed-size requests rather than one.
   *
   * The only caller that embeds an unbounded list. Everything else embeds one
   * question or one document's chunks — `IndexingService` loops per document, so
   * it never sends the whole corpus in a single call and has never needed this.
   * Consolidation sends the entire fact table, which grows, and the provider
   * takes every text in one HTTP request: past the provider's input cap the call
   * fails, the scheduler swallows the error, and merging silently stops working
   * on exactly the store that most needs it.
   */
  private async embedInBatches(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];
    for (let i = 0; i < texts.length; i += CONSOLIDATION_EMBED_BATCH) {
      embeddings.push(
        ...(await this.embeddings.embed(texts.slice(i, i + CONSOLIDATION_EMBED_BATCH))),
      );
    }
    return embeddings;
  }

  private async mergeNearDuplicates(): Promise<number> {
    const facts = await this.facts.all();
    if (facts.length < 2) return 0;

    const embeddings = await this.embedInBatches(facts.map((fact) => fact.text));
    const survivors: { fact: MemoryFact; embedding: number[] }[] = [];
    const doomed: number[] = [];
    let merges = 0;

    for (const [index, fact] of facts.entries()) {
      const embedding = embeddings[index];
      const match = survivors.find(
        (survivor) => l2Distance(survivor.embedding, embedding) <= this.config.memoryDedupDistance,
      );

      if (!match) {
        survivors.push({ fact, embedding });
        continue;
      }

      for (let i = 0; i < fact.accessCount; i += 1) {
        await this.facts.recordRestatement(match.fact.id);
      }
      doomed.push(fact.id);
      merges += 1;
    }

    if (doomed.length > 0) await this.facts.delete(doomed);
    return merges;
  }
}

/**
 * Computed here rather than by round-tripping through `vec_memory_facts`, which
 * only answers "nearest to this vector" and cannot compare two stored facts
 * without one of them being deleted first.
 *
 * L2 to match the metric `vec0` uses, so this and the write-time dedup check
 * are measured on the same scale — see docs/memory-dedup-threshold.md.
 */
function l2Distance(a: number[], b: number[]): number {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) {
    const delta = a[i] - b[i];
    total += delta * delta;
  }
  return Math.sqrt(total);
}

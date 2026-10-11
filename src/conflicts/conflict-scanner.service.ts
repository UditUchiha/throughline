import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Chunk } from '../common/types/knowledge.types';
import type { ChunkRepository } from '../repositories/ports/chunk.repository';
import type { EmbeddingRepository } from '../repositories/ports/embedding.repository';
import { CHUNK_REPOSITORY, EMBEDDING_REPOSITORY } from '../repositories/ports/tokens';
import { ConflictJudge } from './conflict-judge.service';
import type {
  Conflict,
  ConflictCandidate,
  ConflictReport,
  ScannedDocument,
} from './conflict.types';

export interface ScanOptions {
  /** Neighbours compared against each document. */
  neighbours?: number;
  /** Stop after this many documents. For trying a scan without paying for all of it. */
  limit?: number;
  /**
   * Scan only documents whose id contains one of these, by substring.
   *
   * Filters the documents *judged*, never the neighbours they are compared
   * against — those still come from the whole index, or a narrowed scan would
   * be comparing against a corpus that does not exist. This is what makes a
   * known case checkable for two model calls instead of 172, which matters more
   * than it sounds: the first full scan died on a quota wall 92 seconds in, and
   * a detector that can only be verified by a run that cannot complete is a
   * detector nobody verifies.
   */
  docIds?: string[];
  /** Documents judged at once. */
  concurrency?: number;
  signal?: AbortSignal;
}

/**
 * Both known supersessions sit at rank 1 and rank 2 of their document's
 * neighbours, so three covers them with one rank of margin. Raising it costs
 * nothing in model calls — the batch is one call either way — but every extra
 * neighbour is a comparison the model can find a false conflict in, and
 * precision is the metric that decides whether anyone trusts the report.
 */
const DEFAULT_NEIGHBOURS = 3;

/**
 * Measured, not guessed: the first live scan judged 4 documents in 123 seconds,
 * which is 86 minutes for the corpus — long enough that nobody would run it, and
 * a scan nobody runs detects nothing. Almost all of that is waiting on a
 * provider, so the work is IO-bound and overlapping it is nearly free.
 *
 * Four rather than more because the chain in front of this is several
 * rate-limited free tiers. Concurrency past the point where every request draws
 * a 429 does not go faster — it burns a key's remaining budget on retries and
 * pushes the whole scan onto the next credential.
 */
const DEFAULT_CONCURRENCY = 4;

/**
 * Finds claims in the corpus that have stopped being true.
 *
 * The inversion the rest of the system does not do: every other path here is
 * *pull* — a question arrives and evidence is retrieved for it. This is *push*.
 * Nobody asks "is our pricing page still right"; they read it and act on it. A
 * retrieval system that answers from a stale document with a resolving citation
 * makes that worse rather than better, because the citation reads as
 * verification.
 *
 * Deliberately not the agent graph. There is no question to triage, no plan to
 * revise and nothing to synthesise — it is a sweep with a fixed shape, and
 * routing it through LangGraph would buy nothing for the dependency.
 */
@Injectable()
export class ConflictScanner {
  private readonly logger = new Logger(ConflictScanner.name);

  constructor(
    @Inject(CHUNK_REPOSITORY) private readonly chunks: ChunkRepository,
    @Inject(EMBEDDING_REPOSITORY) private readonly embeddings: EmbeddingRepository,
    private readonly judge: ConflictJudge,
  ) {}

  async scan(options: ScanOptions = {}): Promise<ConflictReport> {
    const neighbourCount = options.neighbours ?? DEFAULT_NEIGHBOURS;
    const candidates = await this.candidates(neighbourCount, options.limit, options.docIds);

    this.logger.log(
      `Scanning ${candidates.length} document(s) against ${neighbourCount} neighbour(s) each`,
    );

    // Results are collected by candidate index rather than appended as they
    // land, so the report does not depend on which provider happened to answer
    // first. `--json` exists to be diffed between two scans, which a
    // completion-ordered list would make impossible.
    const found: Conflict[][] = Array.from({ length: candidates.length }, () => []);
    let failures = 0;
    let next = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= candidates.length) return;
        options.signal?.throwIfAborted();

        const candidate = candidates[index];
        try {
          found[index] = await this.judge.judge(candidate, options.signal);
        } catch (error) {
          // One document's verdict failing must not end the sweep — a scan is
          // long and mostly recoverable, and the count is reported so a reader
          // can tell an incomplete audit from a clean one.
          failures++;
          this.logger.warn(
            `Could not judge ${candidate.subject.docId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    };

    const lanes = Math.max(
      1,
      Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, candidates.length),
    );
    await Promise.all(Array.from({ length: lanes }, () => worker()));

    return {
      conflicts: dedupe(found.flat()),
      documentsScanned: candidates.length,
      documentsJudged: candidates.length - failures,
      failures,
    };
  }

  /**
   * Pairs every indexed document with its nearest neighbours. No model calls,
   * so this is free to run and is what the scanner's tests exercise.
   */
  private async candidates(
    neighbourCount: number,
    limit?: number,
    docIds?: string[],
  ): Promise<ConflictCandidate[]> {
    const all = await this.chunks.findAll();
    const scannable = all.filter(hasDocId);

    // `byId` is built from everything, not from `subjects`: narrowing which
    // documents are judged must not narrow what they are judged against.
    const byId = new Map(scannable.map((chunk) => [chunk.id, chunk]));

    const selected =
      docIds && docIds.length > 0
        ? scannable.filter((chunk) => docIds.some((needle) => chunk.docId.includes(needle)))
        : scannable;
    const subjects = limit === undefined ? selected : selected.slice(0, limit);
    const candidates: ConflictCandidate[] = [];

    for (const subject of subjects) {
      const hits = await this.embeddings.neighbours(subject.id, neighbourCount);
      const neighbours = hits
        .map((hit) => byId.get(hit.chunkId))
        .filter(
          (chunk): chunk is Chunk & { docId: string } => chunk !== undefined && hasDocId(chunk),
        )
        // Chunks of one document are near each other by construction, and a
        // document cannot contradict itself in a way worth reporting — it would
        // just be the chunker's overlap surfacing as a finding.
        .filter((chunk) => chunk.docId !== subject.docId);

      if (neighbours.length > 0) {
        candidates.push({ subject: toScanned(subject), neighbours: neighbours.map(toScanned) });
      }
    }

    return candidates;
  }
}

function hasDocId(chunk: Chunk): chunk is Chunk & { docId: string } {
  return chunk.docId !== null;
}

function toScanned(chunk: Chunk & { docId: string }): ScannedDocument {
  return { chunkId: chunk.id, docId: chunk.docId, source: chunk.source, text: chunk.text };
}

/**
 * Collapses the same conflict seen from both ends.
 *
 * A and B being neighbours is very nearly symmetric, so a conflict between them
 * is usually found twice — once while A is the primary and once while B is. The
 * pair is keyed unordered and with the topic, so one document disagreeing with
 * another about two separate things stays two findings.
 *
 * The first is kept rather than merged: the two reports are judgements of the
 * same pair, and picking between them by some quality score would be inventing
 * a comparison the model never made.
 */
function dedupe(conflicts: Conflict[]): Conflict[] {
  const seen = new Map<string, Conflict>();
  for (const conflict of conflicts) {
    const pair = [conflict.outdated.docId, conflict.current.docId].sort().join('::');
    const key = `${pair}::${conflict.topic.trim().toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, conflict);
  }
  return [...seen.values()];
}

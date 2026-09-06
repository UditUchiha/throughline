import type { CorpusSource } from '../common/types/knowledge.types';

/**
 * Identity of a retrieved passage, and the input to `mintEvidenceId`.
 *
 * Corpus chunks use their sqlite rowid, which is why this began life as a plain
 * `number`. M5's MCP-backed tools return passages that were never in the chunk
 * index and have no rowid — and a bare integer from one of those would *collide*
 * with a corpus chunk. `mergeEvidence` in `state.ts` dedupes by `evidenceId`, so
 * the loser is dropped in silence and a citation then resolves to the wrong text:
 * a wrong answer rather than an error.
 *
 * External sources therefore mint a namespaced string with {@link externalChunkId}.
 * The two id spaces cannot overlap, because a corpus id is always a number.
 */
export type ChunkId = number | string;

/**
 * Identity for a passage that did not come from the sqlite-vec index.
 *
 * `namespace` is the connector it came from (`obsidian`, `gmail`); `ref` is
 * whatever that source treats as stable for the passage — a vault-relative path,
 * a message id. Readable rather than hashed on purpose: an `evidenceId` travels
 * over SSE, into the trace store and onto the screen, and
 * `ev-obsidian:Projects/Helios.md#0` can be looked up by hand where `ev--418923`
 * cannot.
 */
export function externalChunkId(namespace: string, ref: string): string {
  return `${namespace}:${ref}`;
}

export interface RetrievedChunk {
  chunkId: ChunkId;
  /**
   * The indexed article this chunk belongs to. `null` for a passage that reached
   * the agent through a connector rather than the index — nothing downstream of
   * the tool boundary reads it, so a fabricated number would be a lie for no gain.
   */
  articleId: number | null;
  articleTitle: string;
  text: string;
  /**
   * Retrieval distance — **lower is more similar**, and not normalised to 0–1.
   *
   * For corpus chunks this is the raw sqlite-vec L2 distance. A connector that
   * does not search by embedding has no such number and must *calibrate* one into
   * the same band, because `synthesize` ranks all evidence on this single field
   * regardless of which tool produced it. See `calibrateDistance` in
   * `src/integrations/mcp/mcp-results.ts`.
   */
  distance: number;
  /** Corpus source type (mail/chat/notes). */
  source: CorpusSource | null;
  /** Stable document identifier from frontmatter. */
  docId: string | null;
}

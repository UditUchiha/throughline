/**
 * The corpus source types — each maps to a subdirectory under the generated corpus.
 *
 * A const tuple rather than a bare union so the runtime list and the type cannot
 * drift apart. They already had: the loader kept its own `Set` of the same three
 * strings and the examples projection its own `z.enum`, so adding a source meant
 * remembering three edits and the failure mode for forgetting was silent — an
 * unrecognised source became `null` on the way in, and the document was indexed
 * unfiltered rather than rejected. `CorpusSource` is now derived from this array
 * and every runtime check goes through {@link isCorpusSource}, so there is one
 * edit and a missed one is a compile error.
 *
 * `src/config/env.schema.ts` still declares its own copy, and that stays: the env
 * schema is parsed before anything else exists and is deliberately free of domain
 * imports, because a cycle there fails the boot in a very confusing way. It is
 * the documented exception, not an oversight.
 */
export const CORPUS_SOURCES = ['mail', 'chat', 'notes'] as const;

export type CorpusSource = (typeof CORPUS_SOURCES)[number];

/**
 * Narrows a value that came from outside the type system — YAML frontmatter, a
 * directory name, a `TEXT` column — into a `CorpusSource`.
 *
 * The alternative was `value as CorpusSource`, which is what
 * `SqliteChunkRepository` used to do: a cast makes the compiler agree that a
 * corrupt or hand-edited `chunks.source` is one of three known strings, and the
 * lie then travels all the way to `SOURCE_STYLES[source]` in the UI.
 */
export function isCorpusSource(value: unknown): value is CorpusSource {
  return typeof value === 'string' && (CORPUS_SOURCES as readonly string[]).includes(value);
}

export interface Article {
  id: number;
  title: string;
  path: string;
  checksum: string;
  updatedAt: string;
}

export interface Chunk {
  id: number;
  articleId: number;
  chunkIndex: number;
  text: string;
  /** Corpus source type derived from the document's frontmatter. */
  source: CorpusSource | null;
  /** Stable document identifier from frontmatter, used for citation tracking. */
  docId: string | null;
}

export interface ChunkSearchResult extends Chunk {
  distance: number;
}

export interface IndexState {
  path: string;
  lastIndexed: string;
  checksum: string;
}

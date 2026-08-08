/** The corpus source types — each maps to a subdirectory under the generated corpus. */
export type CorpusSource = 'mail' | 'chat' | 'notes';

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

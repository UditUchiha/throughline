import type { CorpusSource } from '../common/types/knowledge.types';

export interface RetrievedChunk {
  chunkId: number;
  articleId: number;
  articleTitle: string;
  text: string;
  distance: number;
  /** Corpus source type (mail/chat/notes). */
  source: CorpusSource | null;
  /** Stable document identifier from frontmatter. */
  docId: string | null;
}

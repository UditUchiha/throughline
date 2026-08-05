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
}

export interface ChunkSearchResult extends Chunk {
  distance: number;
}

export interface IndexState {
  path: string;
  lastIndexed: string;
  checksum: string;
}

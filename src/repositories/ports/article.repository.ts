import { Article } from '../../common/types/knowledge.types';

export interface ArticleRepository {
  findByPath(path: string): Promise<Article | null>;
  findById(id: number): Promise<Article | null>;
  upsert(article: { title: string; path: string; checksum: string }): Promise<Article>;
  deleteById(id: number): Promise<void>;
}

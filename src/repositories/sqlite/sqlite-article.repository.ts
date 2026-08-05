import { Inject, Injectable } from '@nestjs/common';
import Database from 'better-sqlite3';
import { SQLITE_CONNECTION } from '../../database/database.constants';
import { Article } from '../../common/types/knowledge.types';
import { ArticleRepository } from '../ports/article.repository';

interface ArticleRow {
  id: number;
  title: string;
  path: string;
  checksum: string;
  updated_at: string;
}

function toArticle(row: ArticleRow): Article {
  return {
    id: row.id,
    title: row.title,
    path: row.path,
    checksum: row.checksum,
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class SqliteArticleRepository implements ArticleRepository {
  constructor(@Inject(SQLITE_CONNECTION) private readonly db: Database.Database) {}

  async findByPath(path: string): Promise<Article | null> {
    const row = this.db
      .prepare<[string], ArticleRow>('SELECT * FROM articles WHERE path = ?')
      .get(path);
    return row ? toArticle(row) : null;
  }

  async findById(id: number): Promise<Article | null> {
    const row = this.db
      .prepare<[number], ArticleRow>('SELECT * FROM articles WHERE id = ?')
      .get(id);
    return row ? toArticle(row) : null;
  }

  async upsert(article: { title: string; path: string; checksum: string }): Promise<Article> {
    const updatedAt = new Date().toISOString();
    const row = this.db
      .prepare<[string, string, string, string], ArticleRow>(
        `INSERT INTO articles (title, path, checksum, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           title = excluded.title,
           checksum = excluded.checksum,
           updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get(article.title, article.path, article.checksum, updatedAt);
    return toArticle(row!);
  }

  async deleteById(id: number): Promise<void> {
    this.db.prepare('DELETE FROM articles WHERE id = ?').run(id);
  }
}

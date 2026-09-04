import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { basename, extname, join, relative } from 'path';
import matter from 'gray-matter';
import type { CorpusSource } from '../common/types/knowledge.types';

export interface LoadedArticle {
  path: string;
  title: string;
  content: string;
  checksum: string;
  /** Corpus source type: derived from frontmatter `source`, or inferred from the parent dir. */
  source: CorpusSource | null;
  /** Stable document identifier from frontmatter `docId`. */
  docId: string | null;
}

const VALID_SOURCES = new Set<string>(['mail', 'chat', 'notes']);

function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

/**
 * Infer the corpus source from a file's relative path when frontmatter is absent.
 * e.g. "mail/thread-42.md" → "mail", "chat/eng-general.2026-02-15.md" → "chat".
 */
function inferSourceFromPath(relPath: string): CorpusSource | null {
  const topDir = relPath.split(/[\\/]/)[0];
  return VALID_SOURCES.has(topDir) ? (topDir as CorpusSource) : null;
}

/** Recursively collect every `.md` file under `dir`, returning absolute paths. */
function findMarkdownFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findMarkdownFiles(full));
    else if (entry.isFile() && extname(entry.name) === '.md') found.push(full);
  }
  return found;
}

/**
 * Loads all Markdown articles under `knowledgePath`, recursing into subfolders so
 * a source-specific subdirectory (e.g. `mail/`, `chat/`, `notes/`) is picked up
 * alongside top-level files. `path` is the identifier and is kept relative to
 * `knowledgePath` (so it stays unique across subfolders, e.g. `mail/thread-42.md`).
 *
 * YAML frontmatter (delimited by `---`) is parsed via `gray-matter`. If present,
 * `source` and `docId` are extracted; otherwise `source` is inferred from the
 * parent directory name and `docId` defaults to null.
 */
export function loadMarkdownArticles(knowledgePath: string): LoadedArticle[] {
  return findMarkdownFiles(knowledgePath).map((fullPath) => {
    const relPath = relative(knowledgePath, fullPath);
    const raw = readFileSync(fullPath, 'utf-8');
    const checksum = createHash('sha256').update(raw).digest('hex');
    const { data: fm, content } = matter(raw);

    const source =
      typeof fm.source === 'string' && VALID_SOURCES.has(fm.source)
        ? (fm.source as CorpusSource)
        : inferSourceFromPath(relPath);
    const docId = typeof fm.docId === 'string' ? fm.docId : null;
    const title =
      typeof fm.title === 'string'
        ? fm.title
        : typeof fm.subject === 'string'
          ? fm.subject
          : extractTitle(content, basename(fullPath, '.md'));

    return { path: relPath, title, content, checksum, source, docId };
  });
}

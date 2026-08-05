import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { basename, extname, join, relative } from 'path';

export interface LoadedArticle {
  path: string;
  title: string;
  content: string;
  checksum: string;
}

function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
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
 */
export function loadMarkdownArticles(knowledgePath: string): LoadedArticle[] {
  return findMarkdownFiles(knowledgePath).map((fullPath) => {
    const relPath = relative(knowledgePath, fullPath);
    const content = readFileSync(fullPath, 'utf-8');
    const checksum = createHash('sha256').update(content).digest('hex');
    const title = extractTitle(content, basename(fullPath, '.md'));

    return { path: relPath, title, content, checksum };
  });
}

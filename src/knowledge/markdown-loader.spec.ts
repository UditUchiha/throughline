import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMarkdownArticles } from './markdown-loader';

/**
 * The loader decides two fields that the eval suite then measures against:
 * `source` (which drives `sourceFilter`, and so `planSourceCoverage` and
 * `recallAtK`) and `docId` (which is how `expectedDocIds` is scored). Both are
 * derived from untrusted-ish input — YAML a generator wrote — and until now
 * nothing pinned the precedence between frontmatter and directory.
 *
 * Real files in a temp directory rather than a mocked `fs`: `gray-matter`,
 * recursion and the relative-path identity are the things being tested, and a
 * mock would assert the shape of the mock.
 */
describe('loadMarkdownArticles', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'throughline-loader-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(relPath: string, content: string): void {
    const full = join(root, relPath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }

  it('identifies an article by its path relative to the corpus root', () => {
    // Absolute paths would make the index non-portable — the checksum table is
    // keyed on this, so a corpus moved or built in a container would reindex
    // every document as new.
    write('mail/thread-42.md', '# Subject\n\nbody');

    const [article] = loadMarkdownArticles(root);

    expect(article.path).toBe(join('mail', 'thread-42.md'));
  });

  it('recurses into source subdirectories', () => {
    write('mail/a.md', '# A');
    write('chat/b.md', '# B');
    write('notes/deep/c.md', '# C');

    const paths = loadMarkdownArticles(root)
      .map((a) => a.path.replace(/\\/g, '/'))
      .sort();

    expect(paths).toEqual(['chat/b.md', 'mail/a.md', 'notes/deep/c.md']);
  });

  it('ignores files that are not markdown', () => {
    write('mail/a.md', '# A');
    write('mail/notes.txt', 'not markdown');
    write('mail/data.json', '{}');

    expect(loadMarkdownArticles(root)).toHaveLength(1);
  });

  it('prefers the frontmatter source over the directory it sits in', () => {
    // The generator writes `source` explicitly; the directory is the fallback.
    write('mail/misfiled.md', '---\nsource: chat\n---\n\n# Body');

    expect(loadMarkdownArticles(root)[0].source).toBe('chat');
  });

  it('infers the source from the top-level directory when frontmatter omits it', () => {
    write('notes/standup.md', '# Standup');

    expect(loadMarkdownArticles(root)[0].source).toBe('notes');
  });

  it('falls back to the directory when frontmatter names a source this build does not know', () => {
    // The old code tested `VALID_SOURCES.has(fm.source)` against a Set declared
    // beside the loader; it now goes through `isCorpusSource`, which is derived
    // from `CORPUS_SOURCES`. Either way an unrecognised value must not be
    // trusted — a cast here would put `slack` into the `source` column and out
    // to the UI as a `CorpusSource`.
    write('mail/odd.md', '---\nsource: slack\n---\n\n# Body');

    expect(loadMarkdownArticles(root)[0].source).toBe('mail');
  });

  it('reports no source rather than guessing when neither frontmatter nor path says', () => {
    write('loose.md', '# Loose');

    expect(loadMarkdownArticles(root)[0].source).toBeNull();
  });

  it('takes docId from frontmatter and null when it is absent', () => {
    write('mail/a.md', '---\ndocId: mail.thread-1.msg-1\n---\n\n# A');
    write('mail/b.md', '# B');

    const byPath = new Map(loadMarkdownArticles(root).map((a) => [a.path, a]));

    expect(byPath.get(join('mail', 'a.md'))!.docId).toBe('mail.thread-1.msg-1');
    expect(byPath.get(join('mail', 'b.md'))!.docId).toBeNull();
  });

  it('titles an article from frontmatter title, then subject, then the first heading', () => {
    write('a.md', '---\ntitle: From title\nsubject: From subject\n---\n\n# From heading');
    write('b.md', '---\nsubject: From subject\n---\n\n# From heading');
    write('c.md', '# From heading');

    const byPath = new Map(loadMarkdownArticles(root).map((a) => [a.path, a.title]));

    expect(byPath.get('a.md')).toBe('From title');
    expect(byPath.get('b.md')).toBe('From subject');
    expect(byPath.get('c.md')).toBe('From heading');
  });

  it('falls back to the filename when a document has no heading at all', () => {
    write('orphan.md', 'body with no heading');

    expect(loadMarkdownArticles(root)[0].title).toBe('orphan');
  });

  it('strips frontmatter from the indexed content', () => {
    // Frontmatter left in `content` would be chunked and embedded, so a search
    // could match on YAML keys rather than prose.
    write('mail/a.md', '---\nsource: mail\ndocId: x\n---\n\n# Heading\n\nthe body');

    const { content } = loadMarkdownArticles(root)[0];

    expect(content).not.toContain('docId');
    expect(content).toContain('the body');
  });

  it('checksums the raw file, so a frontmatter-only edit still reindexes', () => {
    // The checksum is what `reindexAll` skips on. Hashing `content` instead
    // would make a changed `docId` invisible to the indexer — the document would
    // keep its old id in the database while the file on disk disagreed.
    write('a.md', '---\ndocId: one\n---\n\nsame body');
    const first = loadMarkdownArticles(root)[0].checksum;

    write('a.md', '---\ndocId: two\n---\n\nsame body');
    const second = loadMarkdownArticles(root)[0].checksum;

    expect(second).not.toBe(first);
  });
});

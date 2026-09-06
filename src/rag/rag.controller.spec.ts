import { BadRequestException } from '@nestjs/common';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RagController } from './rag.controller';
import type { RetrievalService } from './retrieval.service';
import { searchQuerySchema, type SearchQuery } from './search-query.dto';

/**
 * `GET /knowledge/search` was the one API boundary validating by hand, and the
 * hand-rolled version was wrong in the way the convention exists to prevent.
 *
 * `@Query('q') q: string` is a declaration, not a check — Nest hands back
 * `req.query.q` whatever it holds. On Express 5's default `simple` parser a
 * repeated `?q=a&q=b` is an **array**, and `query.trim()` on one throws a
 * `TypeError` inside the handler, which Nest reports as **500 Internal Server
 * Error**. Confirmed against a running server, along with each 400 below.
 *
 * These pin the boundary, not the search.
 */
describe('GET /knowledge/search — query validation', () => {
  const pipe = new ZodValidationPipe(searchQuerySchema);
  const parse = (query: unknown): SearchQuery => pipe.transform(query);

  it('accepts a plain question', () => {
    expect(parse({ q: 'who approved it?' })).toEqual({ q: 'who approved it?' });
  });

  it('rejects a repeated q as a 400 instead of crashing on .trim()', () => {
    // `?q=a&q=b`. The old code typed this as `string` and called a string method
    // on an array. This is the case that actually reaches the server today.
    expect(() => parse({ q: ['a', 'b'] })).toThrow(BadRequestException);
  });

  it('says q was given more than once, rather than that it is missing', () => {
    // "required" is actively wrong for a caller who can see they supplied it.
    try {
      parse({ q: ['a', 'b'] });
      throw new Error('expected a BadRequestException');
    } catch (error) {
      expect(JSON.stringify((error as BadRequestException).getResponse())).toContain(
        'exactly once',
      );
    }
  });

  it('rejects an object-valued q, which the extended parser can produce', () => {
    // Not reachable under Express 5's default `simple` parser, where `q[x]=1`
    // makes the key literally `q[x]` and leaves `q` absent. Pinned anyway: the
    // schema should not depend on which query parser is configured.
    expect(() => parse({ q: { x: '1' } })).toThrow(BadRequestException);
  });

  it('rejects a missing q', () => {
    expect(() => parse({})).toThrow(BadRequestException);
  });

  it('rejects a q that is only whitespace', () => {
    // The old guard trimmed for the emptiness check and then searched the
    // untrimmed string, so `?q=%20` embedded a space and searched on it.
    expect(() => parse({ q: '   ' })).toThrow(BadRequestException);
  });

  it('trims the query it passes on', () => {
    expect(parse({ q: '  spaced  ' }).q).toBe('spaced');
  });

  it('names the offending field in the error', () => {
    // The point of the pipe over a bare 400: a caller can see which parameter.
    try {
      parse({ q: 'ok', k: '999' });
      throw new Error('expected a BadRequestException');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const response = (error as BadRequestException).getResponse();
      expect(JSON.stringify(response)).toContain('k');
    }
  });

  it('coerces k from its string form and keeps it optional', () => {
    expect(parse({ q: 'x', k: '3' }).k).toBe(3);
    // Absent means "use the configured default", which is RetrievalService's job.
    expect(parse({ q: 'x' }).k).toBeUndefined();
  });

  it('holds the range that keeps one request from scanning the whole index', () => {
    expect(() => parse({ q: 'x', k: '0' })).toThrow(BadRequestException);
    expect(() => parse({ q: 'x', k: '51' })).toThrow(BadRequestException);
    expect(() => parse({ q: 'x', k: '2.5' })).toThrow(BadRequestException);
    expect(() => parse({ q: 'x', k: 'abc' })).toThrow(BadRequestException);
    // An empty `?k=` coerces to 0 and is refused rather than meaning "none".
    expect(() => parse({ q: 'x', k: '' })).toThrow(BadRequestException);
  });

  it('ignores query parameters it does not know about', () => {
    // Rejecting them would break a link carrying a tracking parameter.
    expect(parse({ q: 'x', utm_source: 'readme' })).toEqual({ q: 'x' });
  });
});

describe('RagController', () => {
  it('searches for the validated question and echoes it back', async () => {
    const calls: { query: string; topK?: number }[] = [];
    const retrieval = {
      search: (query: string, topK?: number) => {
        calls.push({ query, topK });
        return Promise.resolve([]);
      },
    } as unknown as RetrievalService;

    const result = await new RagController(retrieval).search({ q: 'who approved it?', k: 3 });

    expect(calls).toEqual([{ query: 'who approved it?', topK: 3 }]);
    expect(result).toEqual({ query: 'who approved it?', results: [] });
  });
});

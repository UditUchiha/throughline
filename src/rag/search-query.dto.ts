import { z } from 'zod';

/**
 * The query string of `GET /knowledge/search`.
 *
 * This endpoint used to validate by hand, which made it the one API boundary in
 * the project not going through `ZodValidationPipe` — and the hand-rolled version
 * was wrong in the way the convention exists to prevent. `@Query('q') q: string`
 * is a declaration, not a check: Nest hands back `req.query.q` whatever it holds.
 * On Express 5's default `simple` query parser a repeated `?q=a&q=b` is an
 * **array**, and `query.trim()` on an array throws a `TypeError` inside the
 * handler — which Nest reports as **500 Internal Server Error**. A malformed
 * request presented as a server fault, with a stack trace logged for something a
 * client did. Reproduced against a running server before this was written.
 *
 * (Under the `extended` parser the same field can arrive as an object instead.
 * Validating the value rather than trusting the annotation covers both, which is
 * the point — the schema does not depend on which parser is configured.)
 *
 * Zod rejects it as a 400 naming the field, and the same schema replaces the
 * manual `Number()` parse and range check for `k`.
 */
export const searchQuerySchema = z.object({
  /**
   * Trimmed before the length check so `?q=%20` is empty rather than a
   * one-character search, which is what the old `query.trim().length === 0`
   * guard intended and then discarded by searching the untrimmed string.
   */
  q: z
    .string({
      // Two different mistakes reach the same check, and telling them apart is
      // the difference between an actionable message and a confusing one:
      // omitting `q` and sending it twice both fail `z.string()`, but "is
      // required" is actively wrong for `?q=a&q=b`, where the caller can see
      // they supplied it.
      error: (issue) =>
        issue.input === undefined
          ? 'Query parameter "q" is required'
          : 'Query parameter "q" must be given exactly once, as a plain string',
    })
    .trim()
    .min(1, 'Query parameter "q" must not be empty'),

  /**
   * Capped at 50 for the same reason as before: `topK` reaches sqlite-vec's `k`,
   * and an unbounded value lets one request scan the entire index.
   *
   * `.optional()` short-circuits ahead of the coercion, so an absent `k` stays
   * `undefined` and `RetrievalService` applies the configured default. An empty
   * `?k=` coerces to 0 and is refused, rather than silently meaning "none".
   */
  k: z.coerce.number().int().min(1).max(50).optional(),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;

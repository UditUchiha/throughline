import type { ZodType, z } from 'zod';

/**
 * Extracts a JSON object from a model response and validates it.
 *
 * Nodes request structured output via `response_format: json_schema`, but not
 * every OpenAI-compatible host honours it identically — some wrap the object in
 * a ```json fence, some prepend a sentence, and `openai-compatible.provider.ts`
 * has a path that retries *without* `response_format` at all. So the strict
 * schema is sent and this is the safety net, not the mechanism.
 *
 * **The net used to have a hole.** This function returned `parsed as T`: it
 * checked that the text parsed to *an object* and then asserted, unchecked, that
 * the object had the shape the caller named. Every field was a promise the model
 * had not made. `plan` did `subQuestions.slice().map()`, `recall` did
 * `standalone?.trim()`, `long-term-memory` did `for (const f of parsed.facts)` —
 * so a response of `{"subQuestions": "sq1, sq2"}` or `{"standalone": 3}` threw a
 * `TypeError` deep inside a node rather than being rejected at the edge. Each of
 * those nodes already has a careful fallback for a `null` return, written and
 * tested; the cast is what stopped them from being reached.
 *
 * A schema is now required, so the model's output is checked exactly like an
 * HTTP body is (§0.3, "no raw type casts at API boundaries"). A model's reply is
 * the least trustworthy input in the system and was the only one exempt.
 *
 * Note this validates what comes *back*. What is sent — each node's
 * `RESPONSE_SCHEMA` — is deliberately untouched: those are hand-written JSON
 * Schema proven against the live providers, and regenerating them is a change
 * whose failure mode is invisible without quota to test it.
 */
export function parseJsonObject<S extends ZodType>(text: string, schema: S): z.infer<S> | null {
  const candidates = [text.trim(), stripCodeFence(text), extractBracedSpan(text)];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      // Validated per candidate rather than once at the end: a chatty provider
      // can produce text whose *first* brace-span parses to some unrelated
      // object, and the fenced body after it is the real answer. Taking the
      // first that merely parses would discard it.
      const result = schema.safeParse(parsed);
      if (result.success) return result.data;
    } catch {
      // Try the next, more aggressive, extraction.
    }
  }
  return null;
}

function stripCodeFence(text: string): string | null {
  const match = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return match ? match[1].trim() : null;
}

function extractBracedSpan(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start !== -1 && end > start ? text.slice(start, end + 1) : null;
}

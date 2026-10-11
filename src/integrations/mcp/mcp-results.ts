import { createHash } from 'node:crypto';
import type { CorpusSource } from '../../common/types/knowledge.types';
import { externalChunkId, type RetrievedChunk } from '../../rag/retrieved-chunk.type';

/**
 * The band a connector's results are mapped into, and the one genuinely
 * uncomfortable number in M5.
 *
 * `synthesize` ranks *all* evidence on `distance` alone and keeps the closest
 * twelve, so a passage from an MCP server competes directly with a passage from
 * the sqlite-vec index — on a scale the connector has no way to measure. An MCP
 * search tool returns a relevance ordering, sometimes a score of its own
 * devising, and never an L2 distance in our embedding space.
 *
 * So this is a **calibration, not a measurement**, and it is deliberately
 * unflattering: the corpus occupies 0.406–0.585 on `gemini-embedding-001`@768
 * (measured across `fixtures/runs/*.json`), and mapping a connector's best hit
 * to 0.45 rather than to 0.40 keeps it competitive with good corpus evidence
 * without automatically outranking it. Erring generous is the dangerous
 * direction — every answer would end up sourced from the connector regardless of
 * how well it actually matched.
 *
 * M6 is where this stops being a judgement call: the eval harness can measure
 * whether connector evidence is over- or under-cited and move the band on
 * evidence. Until then, do not tune it by feel.
 */
const CALIBRATED_BEST = 0.45;
const CALIBRATED_WORST = 0.62;

/** Between snippets joined from one document, so a reader sees the gap. */
const SNIPPET_SEPARATOR = '\n…\n';

/** How much of one passage reaches the prompt. Roughly one corpus chunk. */
const MAX_PASSAGE_CHARS = 4000;

/**
 * Maps a connector's own 0..1 relevance (higher is better) onto the distance
 * scale the rest of the system reads (lower is better).
 */
export function calibrateDistance(relevance: number): number {
  const clamped = Math.min(Math.max(relevance, 0), 1);
  return CALIBRATED_WORST - clamped * (CALIBRATED_WORST - CALIBRATED_BEST);
}

/**
 * Position in the result list, for a server that returns order but no score.
 *
 * A lone result lands **mid-band rather than at the top**. Being first out of one
 * carries no information — there is nothing it was ranked against — and awarding
 * it the best distance a connector can produce is how a weak single match
 * outranks good corpus evidence in the synthesis prompt. It also matters for
 * servers that answer a miss with prose ("No results found."), which is
 * indistinguishable from a real passage at this layer: it cannot be filtered out,
 * but it should not be presented as the strongest thing in the run.
 *
 * Servers that supply their own score never reach this — see `toPassage`.
 */
export function relevanceFromRank(rank: number, total: number): number {
  if (total <= 1) return 0.5;
  return 1 - rank / (total - 1);
}

/**
 * One result as a well-behaved MCP search server describes it. Every field is
 * optional because none of them are in the protocol — `structuredContent` is
 * whatever that server's output schema says, so this is a set of names worth
 * *trying*, not a contract. When none of them are present, the text content
 * blocks are used instead.
 */
interface StructuredResult {
  id?: unknown;
  path?: unknown;
  uri?: unknown;
  /** What a file-oriented server calls its path — Obsidian sends `filename`. */
  filename?: unknown;
  file?: unknown;
  title?: unknown;
  text?: unknown;
  content?: unknown;
  snippet?: unknown;
  /**
   * Hits within one document, for a server that reports *where* it matched
   * rather than returning a passage. See {@link joinMatches}.
   */
  matches?: unknown;
  score?: unknown;
}

interface Passage {
  /** Stable identity within the connector, or undefined if it has none. */
  ref?: string;
  title?: string;
  text: string;
  /** 0..1, higher is better. Undefined means "fall back to rank". */
  relevance?: number;
}

/**
 * The three fields of an MCP tool result this adapter reads, typed structurally
 * rather than imported from the SDK.
 *
 * `Client.callTool` returns a union with the pre-2024 `toolResult` shape, which
 * has no `content` at all, so the SDK's own type cannot be used without a cast
 * at the call site — and §0.3 has no room for one. Declaring what we actually
 * read is also the more honest contract: this is an adapter for a foreign
 * protocol, and it should keep working when that protocol grows a field.
 */
export interface McpToolResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
  /**
   * A result carries `_meta` and whatever else the server saw fit to send. The
   * index signature is also load-bearing for the type check: without it these
   * three optional fields make this a "weak type", and TypeScript then rejects
   * the legacy `{ toolResult }` half of `callTool`'s return union outright.
   */
  [key: string]: unknown;
}

export interface McpChunkOptions {
  /** The configured server name — the `evidenceId` namespace. */
  namespace: string;
  /** Which corpus source this connector's content is filed under. */
  source: CorpusSource;
  /** Cap on passages returned, so one chatty server cannot flood the prompt. */
  topK: number;
}

/**
 * Turns an MCP tool result into the shape the graph already understands.
 *
 * This is the entire adapter layer, and it exists because MCP tools return prose
 * for a human-facing client whereas this system needs passages with stable
 * identities. Two consequences worth not undoing:
 *
 * - **An error result throws.** `execute` distinguishes "searched, found nothing"
 *   from "the search failed" only by whether the call threw, and a consumer
 *   reading `tool_finished` has no other signal. Returning `[]` on `isError`
 *   would render a broken connector as a successful empty search.
 * - **Identity is content-derived when the server offers none.** A hash of the
 *   passage text is stable across runs, which is what `evidenceId` promises, and
 *   two servers returning identical text still differ, because the namespace is
 *   part of the id.
 */
export function toRetrievedChunks(
  result: McpToolResult,
  options: McpChunkOptions,
): RetrievedChunk[] {
  if (result.isError === true) {
    throw new Error(errorMessage(result));
  }

  const passages = readStructured(result) ?? readTextBlocks(result);
  const kept = passages.slice(0, options.topK);

  return kept.map((passage, rank) => {
    const ref = passage.ref ?? contentRef(passage.text);
    const relevance = passage.relevance ?? relevanceFromRank(rank, kept.length);

    return {
      chunkId: externalChunkId(options.namespace, ref),
      articleId: null,
      articleTitle: passage.title ?? ref,
      text: truncate(passage.text),
      distance: calibrateDistance(relevance),
      source: options.source,
      docId: `${options.namespace}:${ref}`,
    };
  });
}

function errorMessage(result: McpToolResult): string {
  const text = readTextBlocks(result)
    .map((passage) => passage.text)
    .join(' ')
    .trim();
  return text || 'MCP tool reported an error with no message';
}

/**
 * `structuredContent`, when it holds something list-shaped.
 *
 * Three outcomes, and keeping them apart is load-bearing:
 *
 * - **No list at all** → `undefined`, so the caller falls through to the text
 *   blocks. The server does not speak this shape.
 * - **An empty list** → `[]`. The server searched and found nothing, and that is
 *   an answer. This case used to return `undefined` too, which sent the caller to
 *   the text blocks and turned a server's human-facing "No matching notes." into
 *   a passage — the only passage, so it took the best distance a connector can
 *   produce and went into the synthesis prompt as strong evidence for a search
 *   that had failed. Silent, because `isError` is false and `tool_finished`
 *   correctly reports success.
 * - **A list we could not read** → `undefined`. Entries with no text mean a shape
 *   this adapter does not understand, which is not the same as no results, so the
 *   text blocks are the better guess.
 */
function readStructured(result: McpToolResult): Passage[] | undefined {
  const structured = result.structuredContent ?? jsonInTextBlocks(result);
  const list = Array.isArray(structured)
    ? structured
    : isRecord(structured) && Array.isArray(structured.results)
      ? structured.results
      : undefined;

  if (!list) return undefined;
  if (list.length === 0) return [];

  const passages = list.filter(isRecord).map(toPassage).filter(isPassage);
  return passages.length > 0 ? passages : undefined;
}

function toPassage(entry: StructuredResult): Passage | null {
  const text = firstString(entry.text, entry.content, entry.snippet) ?? joinMatches(entry.matches);
  if (!text) return null;

  return {
    ref: firstString(entry.path, entry.uri, entry.id, entry.filename, entry.file),
    title: firstString(entry.title, entry.path, entry.uri, entry.filename, entry.file),
    text,
    relevance: usableRelevance(entry.score),
  };
}

/**
 * A result that reports *where* it matched rather than carrying a passage.
 *
 * Obsidian's search is the shape this exists for: one entry per file, with the
 * hits as `matches: [{ context }]`. Joining the contexts reconstructs something
 * quotable; taking only the first would throw away the rest of the evidence in
 * that file, and taking the filename alone would cite a document nobody read.
 */
function joinMatches(matches: unknown): string | undefined {
  if (!Array.isArray(matches)) return undefined;

  const contexts = matches
    .filter(isRecord)
    .map((match) => firstString(match.context, match.text, match.excerpt, match.snippet))
    .filter((context): context is string => context !== undefined);

  return contexts.length > 0 ? contexts.join(SNIPPET_SEPARATOR) : undefined;
}

/**
 * A server's own score, but only when it is on the scale this system assumes.
 *
 * `calibrateDistance` clamps to 0..1 and reads higher as better. A server
 * scoring on any other scale would be silently flattened against an end of that
 * band — Obsidian returns small *negative* numbers (-0.16 beating -0.21), every
 * one of which clamps to 0 and lands every result at the worst distance a
 * connector can produce, destroying the ordering the server took care to send.
 *
 * Rank is the better guess whenever the scale is unknown: the list is already
 * ordered, and `relevanceFromRank` reads that ordering without inventing a
 * magnitude for it.
 */
function usableRelevance(score: unknown): number | undefined {
  if (typeof score !== 'number' || !Number.isFinite(score)) return undefined;
  return score >= 0 && score <= 1 ? score : undefined;
}

/**
 * A JSON array that arrived as text, which is how most MCP servers in the wild
 * still answer: `structuredContent` is a late addition to the protocol, so a
 * server with perfectly good structure usually serialises it into one text
 * block. Without this the whole result set becomes a single giant passage —
 * every hit mashed together under one citation, attributed to no document.
 *
 * Only a parse that yields a list counts. Prose that happens to start with a
 * brace is not structure, and falling through to the text blocks reads it
 * correctly as one passage.
 */
function jsonInTextBlocks(result: McpToolResult): unknown {
  for (const passage of readTextBlocks(result)) {
    const trimmed = passage.text.trim();
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) continue;

    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
      if (isRecord(parsed) && Array.isArray(parsed.results)) return parsed;
    } catch {
      // Not JSON. The text blocks remain the correct reading.
    }
  }
  return undefined;
}

/**
 * Every text block as its own passage. Non-text content — an image, an embedded
 * resource — is dropped rather than described: everything downstream quotes and
 * cites text, and a placeholder standing in for a PNG is a passage that can only
 * mislead.
 */
function readTextBlocks(result: McpToolResult): Passage[] {
  const blocks = Array.isArray(result.content) ? result.content : [];

  return blocks.flatMap((block: unknown) => {
    if (!isRecord(block) || block.type !== 'text') return [];
    const text = block.text;
    return typeof text === 'string' && text.trim().length > 0 ? [{ text }] : [];
  });
}

function contentRef(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function truncate(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_PASSAGE_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_PASSAGE_CHARS)}\n… (truncated)`;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPassage(value: Passage | null): value is Passage {
  return value !== null;
}

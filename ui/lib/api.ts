import type { CorpusSource, EmittedAgentEvent } from './agent-events';
import { readEventStream } from './sse';

/**
 * Where the API lives. The UI and the API deploy separately (Vercel / HF Spaces),
 * so this is always cross-origin in production and cannot be a relative path.
 */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:5000').replace(
  /\/$/,
  '',
);

/**
 * The categories this build knows how to label.
 *
 * A second hand-kept mirror, of `src/agent/examples/example-question.ts` — the
 * same arrangement as `lib/agent-events.ts` and for the same reason, but with no
 * fixtures to pin it, so it drifts more quietly. Nothing here may *narrow* what
 * the API can return: `KnownCategory` is what we have a label for, and
 * {@link QuestionCategory} stays open so a category added on the API side is
 * rendered with its raw name rather than silently dropped from the list.
 */
export const KNOWN_CATEGORIES = [
  'single-hop',
  'multi-hop',
  'temporal',
  'distractor',
  'unanswerable',
  'adversarial',
] as const;

export type KnownCategory = (typeof KNOWN_CATEGORIES)[number];
export type QuestionCategory = KnownCategory | (string & {});

/** One entry of `GET /agent/examples` — a projection of `corpus/questions.yaml`. */
export interface ExampleQuestion {
  id: string;
  question: string;
  category: QuestionCategory;
  requiredSources: CorpusSource[];
  minHops: number;
  expectedAbstention: boolean;
  /** Present when a recorded run exists, which is what makes `?demo=1` work. */
  demoSlug?: string;
}

/** One entry of `GET /agent/demo` — a run already captured to `fixtures/runs/`. */
export interface DemoRun {
  slug: string;
  question: string;
  label?: string;
  capturedAt: string;
  durationMs: number;
  eventCount: number;
}

export async function fetchExamples(signal?: AbortSignal): Promise<ExampleQuestion[]> {
  const response = await fetch(`${API_URL}/agent/examples`, { signal });
  if (!response.ok) throw new Error(`GET /agent/examples returned ${response.status}`);
  const body = (await response.json()) as { questions?: ExampleQuestion[] };
  return body.questions ?? [];
}

export async function fetchDemoRuns(signal?: AbortSignal): Promise<DemoRun[]> {
  const response = await fetch(`${API_URL}/agent/demo`, { signal });
  if (!response.ok) throw new Error(`GET /agent/demo returned ${response.status}`);
  const body = (await response.json()) as { runs?: DemoRun[] };
  return body.runs ?? [];
}

/**
 * Starts a run and yields its events as they arrive.
 *
 * `demo` swaps in a recorded run on the same route, with no model calls. That is
 * the §9 degraded-demo path and also how this UI is developed: one live run costs
 * ~4 calls against a free tier measured in tens per minute.
 */
export async function* askStream(
  question: string,
  options: { demo?: boolean; sessionId?: string; signal?: AbortSignal } = {},
): AsyncGenerator<EmittedAgentEvent> {
  const url = `${API_URL}/agent/ask${options.demo ? '?demo=1' : ''}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ question, sessionId: options.sessionId }),
    signal: options.signal,
  });

  if (!response.ok) {
    // The API validates the body before opening the stream, so a non-2xx here is
    // a plain JSON error and there is no event stream to read.
    throw new Error(await describeHttpError(response));
  }
  if (!response.body) throw new Error('The API returned no response body.');

  yield* readEventStream(response.body, options.signal);
}

async function describeHttpError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'message' in body) {
      const { message } = body as { message: unknown };
      return Array.isArray(message) ? message.join('; ') : String(message);
    }
  } catch {
    // Fall through to the status line.
  }
  return `The API returned ${response.status} ${response.statusText}.`;
}

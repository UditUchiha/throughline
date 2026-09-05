import type { AgentEventType, EmittedAgentEvent } from './agent-events';

/**
 * Reads an SSE body as an async iterable of events.
 *
 * Hand-rolled rather than `EventSource` because the question travels in a POST
 * body — `EventSource` only issues GETs, and putting a free-text question in a
 * query string would cap it at whatever the proxy chain allows.
 *
 * The API writes each frame as `event: <type>\ndata: <json>\n\n` with the type
 * repeated inside the JSON, so only `data:` is parsed here; the named-event line
 * exists for consumers that do use `EventSource`.
 */
export async function* readEventStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<EmittedAgentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // A frame ends at a blank line. Anything after the last one is a partial
      // frame that the next chunk completes.
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        // Checked per frame, not just per read. One chunk routinely carries
        // several events, and yielding suspends this generator — so an abort
        // between two frames of the same chunk would otherwise keep delivering
        // the rest of a run the caller has already walked away from.
        if (signal?.aborted) return;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseFrame(frame);
        if (event) yield event;
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    // Cancelling releases the connection when the consumer stops early — a user
    // who asks a second question should not leave the first stream draining.
    await reader.cancel().catch(() => undefined);
  }
}

const KNOWN_EVENT_TYPES = new Set<string>([
  'run_started',
  'run_replayed',
  'triage_done',
  'plan_created',
  'tool_started',
  'tool_finished',
  'evidence_added',
  'reflect_done',
  'memory_read',
  'memory_written',
  'token_delta',
  'run_finished',
  'run_failed',
] satisfies AgentEventType[]);

function parseFrame(frame: string): EmittedAgentEvent | null {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');

  if (!data) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    // A malformed frame is a bug on the API side, but dropping one event is a far
    // better failure than tearing down a run the visitor is watching.
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as { type?: unknown; seq?: unknown; ts?: unknown };

  // Unknown types are dropped rather than rendered: the contract is append-only,
  // so a UI deployed before an API is expected to meet events it does not know.
  if (typeof candidate.type !== 'string' || !KNOWN_EVENT_TYPES.has(candidate.type)) return null;
  if (typeof candidate.seq !== 'number' || typeof candidate.ts !== 'string') return null;

  return parsed as EmittedAgentEvent;
}

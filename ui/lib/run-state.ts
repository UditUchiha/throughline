import type {
  AgentAnswer,
  Citation,
  Complexity,
  EmittedAgentEvent,
  Evidence,
  MemoryRef,
  SubQuestion,
} from './agent-events';

export type RunStatus = 'idle' | 'streaming' | 'finished' | 'failed';

/** One tool invocation, positioned on the timeline by when it actually ran. */
export interface ToolCall {
  key: string;
  subQuestionId: string;
  tool: string;
  input: string;
  /** ms since the first event of the run. */
  startedAtMs: number;
  finishedAtMs: number | null;
  latencyMs: number | null;
  evidenceIds: string[];
  hop: number;
  /** Non-null when the tool threw — the bar is drawn as a failure, not a hit of zero. */
  error: string | null;
}

export interface Reflection {
  gapFound: boolean;
  followUps: SubQuestion[];
  atMs: number;
}

/** Announced by `run_replayed`; its presence is what the honesty banner renders. */
export interface ReplayInfo {
  slug: string;
  capturedAt: string;
  reason: 'requested' | 'quota_exhausted';
}

/**
 * A memory ref plus which half of the run it belongs to.
 *
 * The direction is only on the wire as the event *type*, and the reducer folds
 * both types into one list — so without capturing it here the panel could show
 * refs but not "reads and writes", which is the thing PLAN.md §5/M4 asks it to
 * show.
 */
export type MemoryEntry = MemoryRef & { direction: 'read' | 'written' };

/** What `recall` turned a follow-up into, when it had to. */
export interface ResolvedQuestion {
  original: string;
  resolved: string;
}

export interface RunView {
  status: RunStatus;
  runId: string | null;
  /**
   * The session this run belongs to, as the API reported it.
   *
   * Read off `run_started` rather than generated here: the API mints one when
   * the caller sends none, so the server's id is the only one both sides agree
   * on. A replay carries none.
   */
  sessionId: string | null;
  question: string;
  /** Set only when the question was rewritten — its absence means it was not. */
  resolvedQuestion: ResolvedQuestion | null;
  replay: ReplayInfo | null;
  triage: { complexity: Complexity; reasoning: string } | null;
  /** False when triage went straight to retrieval — the absence *is* the signal. */
  planned: boolean;
  subQuestions: SubQuestion[];
  toolCalls: ToolCall[];
  evidence: Evidence[];
  reflections: Reflection[];
  memory: MemoryEntry[];
  /** Accumulated `token_delta` text. Today one delta carries the whole answer. */
  streamedText: string;
  answer: AgentAnswer | null;
  citations: Citation[];
  usage: { inputTokens: number; outputTokens: number } | null;
  costUsd: number | null;
  latencyMs: number | null;
  models: string[];
  error: string | null;
  /**
   * Wall-clock ms at which *this* run was started locally.
   *
   * Distinct from {@link RunView.originMs}, which is the first event's server
   * timestamp: this one exists so the live latency readout resets with the run
   * rather than with a React effect that cannot see one streaming run replacing
   * another.
   */
  startedAtMs: number | null;
  /** Epoch ms of the run's first event; the origin for every timeline offset. */
  originMs: number | null;
  /** ms since the origin at the last event — drives the elapsed readout. */
  elapsedMs: number;
}

export const emptyRun: RunView = {
  status: 'idle',
  runId: null,
  sessionId: null,
  question: '',
  resolvedQuestion: null,
  replay: null,
  triage: null,
  planned: false,
  subQuestions: [],
  toolCalls: [],
  evidence: [],
  reflections: [],
  memory: [],
  streamedText: '',
  answer: null,
  citations: [],
  usage: null,
  costUsd: null,
  latencyMs: null,
  models: [],
  error: null,
  startedAtMs: null,
  originMs: null,
  elapsedMs: 0,
};

/**
 * `sessionId` is carried over from the previous run so the session badge does not
 * blink out between asking a follow-up and `run_started` coming back. The API
 * still has the last word on it — see the `run_started` case below.
 */
export function startRun(question: string, sessionId: string | null = null): RunView {
  return { ...emptyRun, status: 'streaming', question, sessionId, startedAtMs: Date.now() };
}

/**
 * Folds one event into the view.
 *
 * Pure and immutable so React can render straight from it. A run is a few dozen
 * events, so copying the whole view per event costs nothing and buys the
 * guarantee that a half-applied event is never rendered.
 */
export function applyEvent(view: RunView, event: EmittedAgentEvent): RunView {
  const eventMs = Date.parse(event.ts);
  const originMs = view.originMs ?? (Number.isNaN(eventMs) ? null : eventMs);
  const offset = originMs === null || Number.isNaN(eventMs) ? 0 : Math.max(eventMs - originMs, 0);

  const base: RunView = {
    ...view,
    originMs,
    elapsedMs: Math.max(view.elapsedMs, offset),
  };

  switch (event.type) {
    case 'run_started':
      return {
        ...base,
        status: 'streaming',
        runId: event.runId,
        sessionId: event.sessionId ?? base.sessionId,
        question: event.question,
      };

    case 'run_replayed':
      return {
        ...base,
        status: 'streaming',
        question: event.question,
        replay: { slug: event.slug, capturedAt: event.capturedAt, reason: event.reason },
      };

    case 'triage_done':
      return { ...base, triage: { complexity: event.complexity, reasoning: event.reasoning } };

    case 'plan_created':
      return {
        ...base,
        planned: true,
        subQuestions: mergeSubQuestions(base.subQuestions, event.subQuestions),
      };

    case 'tool_started': {
      // A simple run never emits `plan_created`, so the sub-question is first seen
      // here. Inventing the record keeps the plan panel and the timeline agreeing
      // rather than leaving one of them empty mid-run.
      const hop = hopFor(base, event.subQuestionId);
      const subQuestions = mergeSubQuestions(base.subQuestions, [
        {
          id: event.subQuestionId,
          text: event.input,
          tool: event.tool,
          status: 'running',
          hop,
        },
      ]);

      return {
        ...base,
        subQuestions,
        toolCalls: [
          ...base.toolCalls,
          {
            key: `${event.subQuestionId}:${base.toolCalls.length}`,
            subQuestionId: event.subQuestionId,
            tool: event.tool,
            input: event.input,
            startedAtMs: offset,
            finishedAtMs: null,
            latencyMs: null,
            evidenceIds: [],
            hop,
            error: null,
          },
        ],
      };
    }

    case 'tool_finished': {
      let closed = false;
      const toolCalls = base.toolCalls.map((call) => {
        if (closed || call.finishedAtMs !== null) return call;
        if (call.subQuestionId !== event.subQuestionId || call.tool !== event.tool) return call;
        closed = true;
        return {
          ...call,
          finishedAtMs: offset,
          latencyMs: event.latencyMs,
          evidenceIds: event.evidenceIds,
          error: event.error ?? null,
        };
      });

      return {
        ...base,
        toolCalls,
        // A tool that threw is not done. `evidenceIds: []` alone cannot say so — a
        // search may legitimately match nothing — so this keys off `error`, and
        // rendering a failed retrieval as a completed one would be the UI lying
        // about the only thing it exists to show.
        subQuestions: markFinished(base.subQuestions, event.subQuestionId, event.error),
      };
    }

    case 'evidence_added':
      return { ...base, evidence: mergeEvidence(base.evidence, event.evidence) };

    case 'reflect_done':
      return {
        ...base,
        reflections: [
          ...base.reflections,
          { gapFound: event.gapFound, followUps: event.followUps, atMs: offset },
        ],
        subQuestions: mergeSubQuestions(base.subQuestions, event.followUps),
      };

    case 'memory_read':
      return { ...base, memory: mergeMemory(base.memory, event.refs, 'read') };

    case 'memory_written':
      return { ...base, memory: mergeMemory(base.memory, event.refs, 'written') };

    case 'followup_resolved':
      // `question` is left as asked. Every later event describes `resolved`, but
      // overwriting what the visitor typed would hide the substitution behind the
      // very thing that makes it worth showing.
      return {
        ...base,
        resolvedQuestion: { original: event.original, resolved: event.resolved },
      };

    case 'token_delta':
      return { ...base, streamedText: base.streamedText + event.text };

    case 'run_finished':
      return {
        ...base,
        status: 'finished',
        answer: event.answer,
        citations: event.citations,
        usage: event.usage,
        costUsd: event.costUsd,
        latencyMs: event.latencyMs,
        models: event.models ?? [],
        // A run that emitted no `token_delta` still has to show its answer.
        streamedText: base.streamedText || event.answer.text,
      };

    case 'run_failed':
      return { ...base, status: 'failed', error: event.error };

    default:
      return base;
  }
}

/**
 * A follow-up's hop comes from the `reflect_done` that created it. When a tool
 * fires for a sub-question nobody planned — the simple path — it belongs to the
 * round currently in flight, which is one per reflection seen so far.
 */
function hopFor(view: RunView, subQuestionId: string): number {
  const known = view.subQuestions.find((sq) => sq.id === subQuestionId);
  return known?.hop ?? view.reflections.length;
}

/**
 * Memory refs are keyed by id in the list, and a run reads the same turn it later
 * writes back — so appending blindly renders duplicate keys for one turn.
 */
function mergeMemory(
  current: MemoryEntry[],
  update: MemoryRef[],
  direction: MemoryEntry['direction'],
): MemoryEntry[] {
  const merged = [...current];
  for (const ref of update) {
    const entry: MemoryEntry = { ...ref, direction };
    const index = merged.findIndex((existing) => existing.id === ref.id);
    if (index === -1) merged.push(entry);
    else merged[index] = entry;
  }
  return merged;
}

function mergeSubQuestions(current: SubQuestion[], update: SubQuestion[]): SubQuestion[] {
  const merged = [...current];
  for (const incoming of update) {
    const index = merged.findIndex((sq) => sq.id === incoming.id);
    if (index === -1) merged.push(incoming);
    else merged[index] = { ...merged[index], ...incoming };
  }
  return merged;
}

function markFinished(current: SubQuestion[], id: string, error?: string): SubQuestion[] {
  return current.map((sq) =>
    sq.id === id
      ? { ...sq, status: error ? ('failed' as const) : ('done' as const), ...(error && { error }) }
      : sq,
  );
}

/**
 * Two sub-questions retrieving the same chunk is corroboration, not a bug — the
 * API dedupes by `evidenceId` in graph state and the UI has to match, or the
 * evidence panel would list the same passage twice.
 */
function mergeEvidence(current: Evidence[], update: Evidence[]): Evidence[] {
  const seen = new Set(current.map((e) => e.evidenceId));
  const merged = [...current];
  for (const evidence of update) {
    if (seen.has(evidence.evidenceId)) continue;
    seen.add(evidence.evidenceId);
    merged.push(evidence);
  }
  return merged;
}

/**
 * Marker for each cited piece of evidence.
 *
 * Built from the `citations` array and never from the evidence's position:
 * synthesis re-sorts evidence by distance and truncates before numbering it, so
 * "the fifth thing retrieved" and "`[5]`" are routinely different passages.
 * Deriving the marker from position points every chip at the wrong card.
 */
export function markersByEvidenceId(citations: Citation[]): Map<string, number> {
  const markers = new Map<string, number>();
  for (const citation of citations) {
    const existing = markers.get(citation.evidenceId);
    if (existing === undefined || citation.marker < existing) {
      markers.set(citation.evidenceId, citation.marker);
    }
  }
  return markers;
}

/** Additional retrieval rounds beyond the first — PLAN.md §7's hop count. */
export function hopCount(view: RunView): number {
  return view.toolCalls.reduce((highest, call) => Math.max(highest, call.hop), 0);
}

/** The window the timeline is drawn against: first tool start → last tool finish. */
export function retrievalWindow(view: RunView): { startMs: number; endMs: number } | null {
  if (view.toolCalls.length === 0) return null;

  const startMs = Math.min(...view.toolCalls.map((call) => call.startedAtMs));
  const endMs = Math.max(
    ...view.toolCalls.map((call) =>
      call.finishedAtMs === null ? Math.max(call.startedAtMs, view.elapsedMs) : call.finishedAtMs,
    ),
  );

  return { startMs, endMs: Math.max(endMs, startMs + 1) };
}

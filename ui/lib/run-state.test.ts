import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EmittedAgentEvent } from './agent-events';
import {
  applyEvent,
  emptyRun,
  hopCount,
  markersByEvidenceId,
  retrievalWindow,
  startRun,
  type RunView,
} from './run-state';

/**
 * Replays the API's own captured runs through the reducer.
 *
 * These are the exact bytes that went over the wire, so a change to the event
 * contract that the UI has not kept up with fails here rather than in a browser.
 * They live outside this package on purpose — `fixtures/runs/` is the API's, and
 * copying them would let the two drift.
 */
const FIXTURE_DIR = join(__dirname, '..', '..', 'fixtures', 'runs');

function loadFixture(slug: string): { question: string; events: EmittedAgentEvent[] } {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${slug}.json`), 'utf8')) as {
    question: string;
    events: EmittedAgentEvent[];
  };
}

function replay(slug: string): RunView {
  const fixture = loadFixture(slug);
  return fixture.events.reduce(applyEvent, startRun(fixture.question));
}

describe('applyEvent over recorded runs', () => {
  it('reduces every captured fixture to a finished run', () => {
    const slugs = readdirSync(FIXTURE_DIR)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace(/\.json$/, ''));

    expect(slugs.length).toBeGreaterThan(0);

    for (const slug of slugs) {
      const view = replay(slug);
      expect(view.status, slug).toBe('finished');
      expect(view.answer, slug).not.toBeNull();
      expect(view.evidence.length, slug).toBeGreaterThan(0);
      // Every tool call has to close, or the timeline leaves a bar pulsing forever.
      expect(
        view.toolCalls.every((call) => call.finishedAtMs !== null),
        slug,
      ).toBe(true);
    }
  });

  it('shows the second hop as a distinct round with its own reflection', () => {
    const view = replay('second-hop-board-outcomes');

    expect(view.planned).toBe(true);
    expect(view.triage?.complexity).toBe('complex');
    expect(hopCount(view)).toBeGreaterThan(0);
    expect(view.reflections.some((reflection) => reflection.gapFound)).toBe(true);
    expect(view.subQuestions.some((subQuestion) => subQuestion.hop > 0)).toBe(true);
  });

  it('records a simple run as unplanned but still fully tracked', () => {
    const view = replay('simple-tariq-start');

    // No `plan_created` ever arrives, so the sub-question exists only because
    // `tool_started` synthesised it. Without that the plan panel and the timeline
    // would disagree about what ran.
    expect(view.planned).toBe(false);
    expect(view.triage?.complexity).toBe('simple');
    expect(view.subQuestions).toHaveLength(1);
    expect(view.subQuestions[0].status).toBe('done');
    expect(view.toolCalls).toHaveLength(1);
  });

  it('treats an abstention as a finished run with no citations', () => {
    const view = replay('abstention-unanswerable');

    expect(view.status).toBe('finished');
    expect(view.answer?.abstained).toBe(true);
    expect(view.citations).toHaveLength(0);
    expect(view.error).toBeNull();
  });

  it('keeps parallel tool calls overlapping on the timeline', () => {
    const view = replay('multihop-helios-owner-cause');
    const window = retrievalWindow(view);

    expect(window).not.toBeNull();

    const firstHop = view.toolCalls.filter((call) => call.hop === 0);
    expect(firstHop.length).toBeGreaterThan(1);

    // The fan-out is the headline visual: if these started sequentially the chart
    // would be telling the visitor something untrue about the graph.
    const latestStart = Math.max(...firstHop.map((call) => call.startedAtMs));
    const earliestFinish = Math.min(...firstHop.map((call) => call.finishedAtMs ?? Infinity));
    expect(latestStart).toBeLessThan(earliestFinish);
  });

  it('dedupes evidence retrieved by more than one sub-question', () => {
    const view = replay('abstention-unanswerable');
    const ids = view.evidence.map((evidence) => evidence.evidenceId);

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('markersByEvidenceId', () => {
  /**
   * The regression this exists for. Synthesis sorts evidence by distance and
   * truncates before numbering it, so `[5]` is routinely *not* the fifth chunk
   * retrieved. Deriving markers from arrival order points every citation chip at
   * the wrong evidence card — checked here against a real run where the two
   * orderings genuinely differ.
   */
  it('maps markers by the citation table, never by arrival order', () => {
    const view = replay('second-hop-board-outcomes');
    const markers = markersByEvidenceId(view.citations);

    expect(view.citations.length).toBeGreaterThan(0);

    for (const citation of view.citations) {
      expect(markers.get(citation.evidenceId)).toBe(citation.marker);

      const arrivalIndex = view.evidence.findIndex(
        (evidence) => evidence.evidenceId === citation.evidenceId,
      );
      expect(arrivalIndex).toBeGreaterThanOrEqual(0);
    }

    const anyDisagreement = view.citations.some(
      (citation) =>
        view.evidence.findIndex((evidence) => evidence.evidenceId === citation.evidenceId) !==
        citation.marker - 1,
    );
    expect(anyDisagreement).toBe(true);
  });
});

describe('applyEvent edge cases', () => {
  const at = (ms: number) => new Date(Date.parse('2026-09-04T00:00:00.000Z') + ms).toISOString();

  it('reports a failed run without losing what already arrived', () => {
    const events = [
      { type: 'run_started', runId: 'r1', question: 'q', seq: 0, ts: at(0) },
      { type: 'triage_done', complexity: 'complex', reasoning: 'two sources', seq: 1, ts: at(10) },
      { type: 'run_failed', error: 'quota exhausted', seq: 2, ts: at(20) },
    ] as EmittedAgentEvent[];

    const view = events.reduce(applyEvent, startRun('q'));

    expect(view.status).toBe('failed');
    expect(view.error).toBe('quota exhausted');
    expect(view.triage?.complexity).toBe('complex');
  });

  it('falls back to the finished answer when no token_delta ever arrives', () => {
    const events = [
      { type: 'run_started', runId: 'r1', question: 'q', seq: 0, ts: at(0) },
      {
        type: 'run_finished',
        answer: {
          text: 'Because [1].',
          citations: [{ marker: 1, evidenceId: 'ev-1' }],
          abstained: false,
        },
        citations: [{ marker: 1, evidenceId: 'ev-1' }],
        usage: { inputTokens: 10, outputTokens: 5 },
        costUsd: null,
        latencyMs: 40,
        seq: 1,
        ts: at(40),
      },
    ] as EmittedAgentEvent[];

    const view = events.reduce(applyEvent, startRun('q'));

    expect(view.streamedText).toBe('Because [1].');
    expect(view.models).toEqual([]);
  });

  /**
   * The regression: `tool_finished` looks identical whether the tool threw or
   * simply matched nothing, so the reducer used to mark both `done`. A failed
   * retrieval then rendered with a green dot, which is the UI misreporting the
   * one thing it exists to show.
   */
  it('marks a sub-question failed when its tool_finished carries an error', () => {
    const events = [
      { type: 'run_started', runId: 'r1', question: 'q', seq: 0, ts: at(0) },
      {
        type: 'plan_created',
        subQuestions: [
          { id: 'sq1', text: 'a', tool: 'mail_search', status: 'pending', hop: 0 },
          { id: 'sq2', text: 'b', tool: 'chat_search', status: 'pending', hop: 0 },
        ],
        seq: 1,
        ts: at(10),
      },
      { type: 'tool_started', subQuestionId: 'sq1', tool: 'mail_search', input: 'a', seq: 2, ts: at(20) },
      { type: 'tool_started', subQuestionId: 'sq2', tool: 'chat_search', input: 'b', seq: 3, ts: at(20) },
      {
        type: 'tool_finished',
        subQuestionId: 'sq1',
        tool: 'mail_search',
        evidenceIds: [],
        latencyMs: 12,
        error: 'index unavailable',
        seq: 4,
        ts: at(40),
      },
      // No error, and also no evidence — a search that legitimately matched
      // nothing. It must stay `done`, or the two cases are conflated the other way.
      {
        type: 'tool_finished',
        subQuestionId: 'sq2',
        tool: 'chat_search',
        evidenceIds: [],
        latencyMs: 15,
        seq: 5,
        ts: at(45),
      },
    ] as EmittedAgentEvent[];

    const view = events.reduce(applyEvent, startRun('q'));
    const byId = new Map(view.subQuestions.map((sq) => [sq.id, sq]));

    expect(byId.get('sq1')?.status).toBe('failed');
    expect(byId.get('sq1')?.error).toBe('index unavailable');
    expect(byId.get('sq2')?.status).toBe('done');
    expect(byId.get('sq2')?.error).toBeUndefined();

    const callsById = new Map(view.toolCalls.map((call) => [call.subQuestionId, call]));
    expect(callsById.get('sq1')?.error).toBe('index unavailable');
    expect(callsById.get('sq2')?.error).toBeNull();
  });

  it('adopts the session the API reports and keeps it through the run', () => {
    const events = [
      { type: 'run_started', runId: 'r1', question: 'q', sessionId: 's-1', seq: 0, ts: at(0) },
      { type: 'triage_done', complexity: 'simple', reasoning: 'one fact', seq: 1, ts: at(10) },
    ] as EmittedAgentEvent[];

    const view = events.reduce(applyEvent, startRun('q'));

    expect(view.sessionId).toBe('s-1');
  });

  it('does not let a run without a session id clear the one already held', () => {
    // Replays carry no session, and so do runs captured before the field existed.
    // Treating either as "the session ended" would silently break the next
    // follow-up in a live conversation.
    const view = applyEvent(startRun('q', 's-1'), {
      type: 'run_started',
      runId: 'r2',
      question: 'q',
      seq: 0,
      ts: at(0),
    } as EmittedAgentEvent);

    expect(view.sessionId).toBe('s-1');
  });

  it('records a resolved follow-up without overwriting what was asked', () => {
    const view = applyEvent(startRun('Who approved it?'), {
      type: 'followup_resolved',
      original: 'Who approved it?',
      resolved: 'Who approved the new Helios launch date?',
      seq: 1,
      ts: at(10),
    } as EmittedAgentEvent);

    // Both halves are needed on screen: every other panel describes the resolved
    // question, and only the original tells the visitor what they typed.
    expect(view.question).toBe('Who approved it?');
    expect(view.resolvedQuestion).toEqual({
      original: 'Who approved it?',
      resolved: 'Who approved the new Helios launch date?',
    });
  });

  it('separates memory reads from memory writes', () => {
    const events = [
      { type: 'run_started', runId: 'r1', question: 'q', sessionId: 's-1', seq: 0, ts: at(0) },
      {
        type: 'memory_read',
        refs: [{ id: 'turn-1', kind: 'session_turn', text: 'earlier question — earlier answer' }],
        seq: 1,
        ts: at(10),
      },
      {
        type: 'memory_written',
        refs: [{ id: 'turn-r1', kind: 'session_turn', text: 'this question — this answer' }],
        seq: 2,
        ts: at(20),
      },
    ] as EmittedAgentEvent[];

    const view = events.reduce(applyEvent, startRun('q'));

    // Direction is only on the wire as the event type. Flattening both into one
    // list without it leaves the panel unable to show reads *and* writes.
    expect(view.memory.map((ref) => ref.direction)).toEqual(['read', 'written']);
  });

  it('marks a replay from the leading run_replayed event', () => {
    const view = applyEvent(emptyRun, {
      type: 'run_replayed',
      slug: 'multihop-helios-delay',
      question: 'Why did Helios slip?',
      capturedAt: '2026-09-04T13:28:54.317Z',
      reason: 'requested',
      seq: 0,
      ts: at(0),
    } as EmittedAgentEvent);

    expect(view.replay?.slug).toBe('multihop-helios-delay');
    expect(view.replay?.capturedAt).toBe('2026-09-04T13:28:54.317Z');
  });
});

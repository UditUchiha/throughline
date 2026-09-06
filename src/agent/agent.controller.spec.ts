import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { AgentController } from './agent.controller';
import type { AgentGraphService } from './agent-graph.service';
import type { RunReplayService } from './replay/run-replay.service';
import type { ExampleQuestionsService } from './examples/example-questions.service';
import type { TraceRepository } from '../repositories/ports/trace.repository';
import { AbstentionConsistencyGuardrail } from '../guardrails/abstention-consistency.guardrail';
import { CitationCoverageGuardrail } from '../guardrails/citation-coverage.guardrail';
import { ExfiltrationGuardrail } from '../guardrails/exfiltration.guardrail';
import { GuardrailService } from '../guardrails/guardrail.service';
import { InjectionDetectionGuardrail } from '../guardrails/injection-detection.guardrail';
import { QuestionAbuseGuardrail } from '../guardrails/question-abuse.guardrail';
import { AllProvidersFailedError } from '../ai/llm/failover-llm.service';
import type { AppConfigService } from '../config/app-config.service';
import { QuotaFallbackService } from './quota-fallback.service';
import type { RunFixture } from './replay/run-fixture';

/**
 * Builds a controller over fakes, shared by both suites below.
 *
 * At module scope rather than inside a `describe` because the quota-fallback
 * tests need the same wiring, and a second copy of it would drift from this one
 * the first time the constructor gains an argument.
 */
function build(options: { failWith?: Error; fixture?: boolean } = {}) {
  const runs: string[] = [];
  const graph = {
    run: (args: { question: string }) => {
      runs.push(args.question);
      if (options.failWith) return Promise.reject(options.failWith);
      return Promise.resolve({});
    },
  } as unknown as AgentGraphService;

  const replayed: { slug: string; reason: string }[] = [];
  const fixture = { slug: 'fixture-1', question: 'q', events: [] } as unknown as RunFixture;
  const replay = {
    find: () => (options.fixture === false ? undefined : fixture),
    list: () => [],
    replay: (f: RunFixture, _sink: unknown, opts: { reason: string }) => {
      replayed.push({ slug: f.slug, reason: opts.reason });
      return Promise.resolve();
    },
  } as unknown as RunReplayService;

  const quota = new QuotaFallbackService({
    quotaFallbackCooldownMs: 60_000,
  } as unknown as AppConfigService);

  const guardrails = new GuardrailService(
    new QuestionAbuseGuardrail(),
    new InjectionDetectionGuardrail(),
    new CitationCoverageGuardrail(),
    new ExfiltrationGuardrail(),
    new AbstentionConsistencyGuardrail(),
  );

  const controller = new AgentController(
    graph,
    {} as TraceRepository,
    replay,
    {} as ExampleQuestionsService,
    guardrails,
    quota,
  );

  const headers: string[] = [];
  const response = {
    setHeader: (name: string) => headers.push(name),
    flushHeaders: () => undefined,
    write: () => true,
    end: () => undefined,
    on: () => response,
  } as unknown as Response;

  return { controller, response, headers, runs, replayed, quota };
}

/**
 * The input guardrail, at the one place it can actually refuse something.
 *
 * `POST /agent/ask` takes over the response to stream SSE, so a refusal has to
 * happen *before* the headers go out — after that the only way to say no is an
 * in-band `run_failed` with an HTTP 200 attached. That ordering is the behaviour
 * worth pinning; the guardrail's own logic is covered in `guardrails.spec.ts`.
 */
describe('AgentController — the input guardrail', () => {
  it('runs an ordinary question', async () => {
    const { controller, response, runs } = build();

    await controller.ask(
      { question: 'Who approved the revised Helios date?' },
      undefined,
      response,
    );

    expect(runs).toEqual(['Who approved the revised Helios date?']);
  });

  it('refuses an oversized question before the stream opens', async () => {
    const { controller, response, headers, runs } = build();

    await expect(
      controller.ask({ question: 'a'.repeat(900) }, undefined, response),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Nothing was spent and nothing was streamed: no model call, and the response
    // is still a plain HTTP response Nest can turn into a 400.
    expect(runs).toEqual([]);
    expect(headers).toEqual([]);
  });

  it('runs an adversarial question from the answer key rather than refusing it', async () => {
    // The eval suite scores three questions that talk about injection attempts.
    // A guardrail that blocked on the vocabulary would refuse the questions it is
    // measured against — which would have read as a hardening win until the
    // numbers came back.
    const { controller, response, runs } = build();
    const question = 'What injection attempts have we seen, and what rule did we write down?';

    await controller.ask({ question }, undefined, response);

    expect(runs).toEqual([question]);
  });
});

/**
 * PLAN.md §9's degraded demo: an exhausted free tier serves a recording with an
 * honest banner rather than a failure.
 *
 * The event contract has carried `run_replayed.reason: 'quota_exhausted'` since
 * M2 and `ReplayBanner` has rendered it for just as long — but nothing on the
 * API side ever set it, so the whole path was unreachable. These pin the two
 * halves that make it honest: only a quota wall arms it, and a recording is
 * never served in the middle of a run that has already started streaming.
 */
describe('AgentController — the quota fallback', () => {
  const QUESTION = 'Who approved the revised Helios date?';

  it('still attempts a live run while the breaker is closed', async () => {
    const { controller, response, runs, replayed } = build();

    await controller.ask({ question: QUESTION }, undefined, response);

    expect(runs).toEqual([QUESTION]);
    expect(replayed).toEqual([]);
  });

  it('replays with an honest reason once every provider is out of quota', async () => {
    const quotaWall = new AllProvidersFailedError('gemini: 429, groq: 429', true);
    const { controller, response, quota } = build({ failWith: quotaWall });

    // The run that hits the wall reports its own failure — the stream is already
    // open, so a recording could only arrive after `run_failed`, and
    // `run_replayed` is contractually the *first* event of a replay.
    await controller.ask({ question: QUESTION }, undefined, response);
    expect(quota.isOpen).toBe(true);

    const next = build();
    next.quota.recordFailure(quotaWall);
    await next.controller.ask({ question: QUESTION }, undefined, next.response);

    expect(next.runs).toEqual([]);
    expect(next.replayed).toEqual([{ slug: 'fixture-1', reason: 'quota_exhausted' }]);
  });

  it('does not arm on a failure that a recording would misrepresent', async () => {
    // A timeout, an abort or one unreachable provider are outages. Answering an
    // outage with a cheerful fixture is the dishonesty the banner exists to stop.
    for (const failure of [
      new Error('AgentGraphService timed out'),
      new AllProvidersFailedError('gemini: ECONNRESET, groq: 503', false),
    ]) {
      const { controller, response, quota } = build({ failWith: failure });
      await controller.ask({ question: QUESTION }, undefined, response);
      expect([failure.message, quota.isOpen]).toEqual([failure.message, false]);
    }
  });

  it('runs live again after a success, without waiting for the window', async () => {
    const { controller, response, quota, runs } = build();
    quota.recordFailure(new AllProvidersFailedError('gemini: 429', true));
    expect(quota.isOpen).toBe(true);

    quota.recordSuccess();
    await controller.ask({ question: QUESTION }, undefined, response);

    expect(quota.isOpen).toBe(false);
    expect(runs).toEqual([QUESTION]);
  });

  it('attempts the run anyway when no recording covers the question', async () => {
    // Better a real failure the visitor can read than a replay of a different
    // question, and `replay.find()` returning nothing is the only signal for it.
    const { controller, response, quota, runs, replayed } = build({ fixture: false });
    quota.recordFailure(new AllProvidersFailedError('gemini: 429', true));

    await controller.ask({ question: QUESTION }, undefined, response);

    expect(runs).toEqual([QUESTION]);
    expect(replayed).toEqual([]);
  });

  it('never counts a ?demo=1 replay as a quota failure', async () => {
    const { controller, response, quota, replayed } = build();

    await controller.ask({ question: QUESTION }, '1', response);

    expect(replayed).toEqual([{ slug: 'fixture-1', reason: 'requested' }]);
    expect(quota.isOpen).toBe(false);
  });
});

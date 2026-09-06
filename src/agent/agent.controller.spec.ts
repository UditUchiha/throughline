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

/**
 * The input guardrail, at the one place it can actually refuse something.
 *
 * `POST /agent/ask` takes over the response to stream SSE, so a refusal has to
 * happen *before* the headers go out — after that the only way to say no is an
 * in-band `run_failed` with an HTTP 200 attached. That ordering is the behaviour
 * worth pinning; the guardrail's own logic is covered in `guardrails.spec.ts`.
 */
describe('AgentController — the input guardrail', () => {
  function build() {
    const runs: string[] = [];
    const graph = {
      run: (options: { question: string }) => {
        runs.push(options.question);
        return Promise.resolve({});
      },
    } as unknown as AgentGraphService;

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
      {} as RunReplayService,
      {} as ExampleQuestionsService,
      guardrails,
    );

    const headers: string[] = [];
    const response = {
      setHeader: (name: string) => headers.push(name),
      flushHeaders: () => undefined,
      write: () => true,
      end: () => undefined,
      on: () => response,
    } as unknown as Response;

    return { controller, response, headers, runs };
  }

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

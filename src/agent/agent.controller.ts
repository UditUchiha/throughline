import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { GuardrailService } from '../guardrails/guardrail.service';
import { AgentGraphService } from './agent-graph.service';
import { AskThrottlerGuard, isDemoReplay } from './ask-throttler.guard';
import { QuotaFallbackService } from './quota-fallback.service';
import { TRACE_REPOSITORY } from '../repositories/ports/tokens';
import type { TraceRepository } from '../repositories/ports/trace.repository';
import type { PersistedRun, RunSpan } from '../common/types/trace.types';
import { askRequestSchema, type AskRequest } from './dto/ask.dto';
import type { EmittedAgentEvent } from './events';
import { RunReplayService } from './replay/run-replay.service';
import { normaliseQuestion, type RunFixtureSummary } from './replay/run-fixture';
import { ExampleQuestionsService } from './examples/example-questions.service';
import type { ExampleQuestion } from './examples/example-question';

@Controller('agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly graph: AgentGraphService,
    @Inject(TRACE_REPOSITORY) private readonly traces: TraceRepository,
    private readonly replay: RunReplayService,
    private readonly examples: ExampleQuestionsService,
    private readonly guardrails: GuardrailService,
    private readonly quota: QuotaFallbackService,
  ) {}

  /**
   * Runs the agent and streams its events as they happen.
   *
   * SSE rather than a JSON response because the reasoning *is* the demo — a
   * visitor watching the plan appear and the tools fan out learns more in ten
   * seconds than a finished paragraph conveys (PLAN.md §1).
   *
   * `@Res()` takes over the response: Nest's `@Sse()` decorator only registers
   * GET routes, and the question belongs in a body rather than a query string.
   *
   * `?demo=1` replays a recorded run instead of calling any model. Same route and
   * same event stream on purpose — a demo that travels a different code path
   * stops resembling the thing it demonstrates.
   */
  // On this route alone, not the controller. The two GETs read committed files
  // and cost nothing a visitor could exhaust; this is the one that spends the
  // day's model-call budget, and a limit that also throttles the example list
  // would break the page for someone who has not asked anything yet.
  @UseGuards(AskThrottlerGuard)
  @Post('ask')
  async ask(
    @Body(new ZodValidationPipe(askRequestSchema)) body: AskRequest,
    @Query('demo') demo: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    // Before the stream opens, because once headers are sent a refusal can only
    // be an in-band `run_failed` and the caller sees HTTP 200. The Zod DTO has
    // already bounded the body; this is the abuse-shape check on top of it
    // (PLAN.md §5/M6.2). Which verdicts actually refuse is the service's business,
    // not this controller's — `blocked()` answers it without naming a guardrail.
    const inputVerdicts = await this.guardrails.checkQuestion({ question: body.question });
    this.guardrails.report('pre-run', inputVerdicts);
    const blocking = this.guardrails.blocked(inputVerdicts);
    if (blocking) {
      throw new BadRequestException(blocking.detail);
    }

    const write = this.openEventStream(response);

    // A visitor who closes the tab should stop costing model calls immediately.
    //
    // This listens on the *response*, not the request. `request.on('close')` looks
    // like the right hook and is not: since Node 16 an `IncomingMessage` emits
    // `close` when the request stream completes — i.e. as soon as the JSON body has
    // been read — so it fired ~2ms into every run rather than on disconnect. That
    // went unnoticed because it aborted the signal before `graph.run()` ever
    // attached its listener, and a listener added after the event has fired never
    // runs; the two mistakes cancelled out and nothing was cancellable at all.
    // `response` emits `close` when the socket actually goes away (and again after
    // a normal `end()`, which is harmless — the run has already returned by then).
    const controller = new AbortController();
    response.on('close', () => controller.abort());

    try {
      if (isDemoReplay(demo)) {
        await this.streamRecorded(body.question, write, 'requested', controller.signal);
        return;
      }

      // Checked before the graph runs, not after it fails, so `run_replayed`
      // stays the first event the client sees — which is what stops a recording
      // from being mistaken for a live run. See QuotaFallbackService.
      if (this.quota.isOpen && this.replay.find(body.question)) {
        await this.streamRecorded(body.question, write, 'quota_exhausted', controller.signal);
        return;
      }

      // The run records its own trace — including when it fails, which is why
      // nothing is saved here. See AgentGraphService.run().
      await this.graph.run({
        question: body.question,
        sessionId: body.sessionId,
        sink: write,
        signal: controller.signal,
      });
      this.quota.recordSuccess();
    } catch (error) {
      this.quota.recordFailure(error);
      // The graph has already emitted `run_failed` to the sink, so the client
      // knows; this is only about not leaving the request hanging.
      this.logger.error(`Agent run failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      response.end();
    }
  }

  /**
   * The recorded runs available for replay.
   *
   * Doubles as the source for the UI's one-click example questions: a visitor
   * does not know what to ask this corpus, and every question here is known to
   * produce a good answer because it already did once.
   */
  @Get('demo')
  listDemoRuns(): { runs: RunFixtureSummary[] } {
    return { runs: this.replay.list() };
  }

  /**
   * The authored question set, as one-click examples for the UI.
   *
   * `demoSlug` is filled in where a recorded run exists for the question, so the
   * UI can tell a visitor which examples still work with the API's quota spent.
   */
  @Get('examples')
  listExamples(): { questions: ExampleQuestion[] } {
    // One pass over the fixtures rather than `replay.find()` per question: `find`
    // re-stats the fixture directory on every call, so the obvious version cost
    // ~280 synchronous fs syscalls per request on an endpoint with no rate limit.
    const slugByQuestion = new Map(
      this.replay.list().map((run) => [normaliseQuestion(run.question), run.slug]),
    );

    const questions = this.examples.list().map((question) => {
      const slug = slugByQuestion.get(normaliseQuestion(question.question));
      return slug ? { ...question, demoSlug: slug } : question;
    });
    return { questions };
  }

  /**
   * One run, whole: its metadata, the exact event stream it produced, and its span
   * tree (PLAN.md §5/M3.2).
   *
   * Durable since M3 — the in-memory store this replaced was capped at 100 runs and
   * emptied on every restart, so a link to a run rarely survived long enough to be
   * worth sending anyone.
   */
  @Get('runs/:runId')
  async getRun(@Param('runId') runId: string): Promise<{ run: PersistedRun; spans: RunSpan[] }> {
    const trace = await this.traces.get(runId);
    if (!trace) {
      throw new NotFoundException(`No recorded run "${runId}"`);
    }
    return trace;
  }

  private async streamRecorded(
    question: string,
    write: (event: EmittedAgentEvent) => void,
    reason: 'requested' | 'quota_exhausted',
    signal: AbortSignal,
  ): Promise<void> {
    const fixture = this.replay.find(question);

    if (!fixture) {
      // Reported in-stream rather than as a 404, because the response headers are
      // already sent and the client is reading events, not status codes.
      write({
        type: 'run_failed',
        error:
          `No recorded run for "${question}". Available: ` +
          `${
            this.replay
              .list()
              .map((r) => r.question)
              .join(' | ') || '(none captured yet — run pnpm capture:runs)'
          }`,
        seq: 0,
        ts: new Date().toISOString(),
      });
      return;
    }

    await this.replay.replay(fixture, write, { reason, signal });
  }

  private openEventStream(response: Response): (event: EmittedAgentEvent) => void {
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    // Tells nginx-style proxies not to buffer, which would defeat streaming.
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    return (event: EmittedAgentEvent): void => {
      // Named events let EventSource consumers subscribe per type; the same
      // payload is repeated in `data` so a generic onmessage handler also works.
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
  }
}

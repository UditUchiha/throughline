import {
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AgentGraphService } from './agent-graph.service';
import { AgentRunStore, type RecordedRun } from './agent-run.store';
import { askRequestSchema, type AskRequest } from './dto/ask.dto';
import type { EmittedAgentEvent } from './events';
import { RunReplayService } from './replay/run-replay.service';
import type { RunFixtureSummary } from './replay/run-fixture';

@Controller('agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly graph: AgentGraphService,
    private readonly runs: AgentRunStore,
    private readonly replay: RunReplayService,
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
  @Post('ask')
  async ask(
    @Body(new ZodValidationPipe(askRequestSchema)) body: AskRequest,
    @Query('demo') demo: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    const write = this.openEventStream(response);

    // A visitor who closes the tab should stop costing model calls immediately.
    const controller = new AbortController();
    request.on('close', () => controller.abort());

    try {
      if (demo === '1' || demo === 'true') {
        await this.streamRecorded(body.question, write, controller.signal);
        return;
      }

      const result = await this.graph.run({
        question: body.question,
        sessionId: body.sessionId,
        sink: write,
        signal: controller.signal,
      });
      this.runs.save(result, startedAt);
    } catch (error) {
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

  @Get('runs/:runId')
  getRun(@Param('runId') runId: string): RecordedRun {
    const run = this.runs.get(runId);
    if (!run) {
      throw new NotFoundException(`No recorded run "${runId}"`);
    }
    return run;
  }

  private async streamRecorded(
    question: string,
    write: (event: EmittedAgentEvent) => void,
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

    await this.replay.replay(fixture, write, { reason: 'requested', signal });
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

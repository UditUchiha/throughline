import { Body, Controller, Get, NotFoundException, Param, Post, Req, Res } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AgentGraphService } from './agent-graph.service';
import { AgentRunStore, type RecordedRun } from './agent-run.store';
import { askRequestSchema, type AskRequest } from './dto/ask.dto';
import type { EmittedAgentEvent } from './events';

@Controller('agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly graph: AgentGraphService,
    private readonly runs: AgentRunStore,
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
   */
  @Post('ask')
  async ask(
    @Body(new ZodValidationPipe(askRequestSchema)) body: AskRequest,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const startedAt = new Date().toISOString();

    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    // Tells nginx-style proxies not to buffer, which would defeat streaming.
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    const write = (event: EmittedAgentEvent): void => {
      // Named events let EventSource consumers subscribe per type; the same
      // payload is repeated in `data` so a generic onmessage handler also works.
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    // A visitor who closes the tab should stop costing model calls immediately.
    const controller = new AbortController();
    request.on('close', () => controller.abort());

    try {
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

  @Get('runs/:runId')
  getRun(@Param('runId') runId: string): RecordedRun {
    const run = this.runs.get(runId);
    if (!run) {
      throw new NotFoundException(`No recorded run "${runId}"`);
    }
    return run;
  }
}

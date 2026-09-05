import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { awaitAllCallbacks } from '@langchain/core/callbacks/promises';
import type OpenAI from 'openai';
import { Client } from 'langsmith';
import { wrapOpenAI } from 'langsmith/wrappers';
import { traceable } from 'langsmith/traceable';
import { AppConfigService } from '../config/app-config.service';

/**
 * Turns LangSmith tracing on and gives the LLM layer a way to be traced (PLAN.md
 * §5/M3.1).
 *
 * Two things have to happen for a trace to show planner → tool → LLM rather than
 * planner → tool:
 *
 * 1. **LangGraph reports itself.** It reads `LANGSMITH_*` straight out of
 *    `process.env`, so the values validated in `env.schema.ts` are copied back
 *    there below. §0.3 forbids *reading* env outside `src/config`, which this
 *    honours — every value comes from `AppConfigService`, and the variables are
 *    declared in the Zod schema first. Writing them back is the only way to
 *    configure a library that insists on reading them itself.
 *
 * 2. **The model calls have to be wrapped.** This is the part that is easy to get
 *    wrong: LangGraph auto-tracing covers the *graph*, and every model call here
 *    goes through the raw `openai` SDK rather than a LangChain chat model, so
 *    without `wrapOpenAI` the LLM level of the hierarchy is simply absent and the
 *    trace stops at the node. `wrapClient` is what closes that gap.
 */
@Injectable()
export class LangSmithTracing implements OnApplicationShutdown {
  private readonly logger = new Logger(LangSmithTracing.name);
  private readonly enabled: boolean;
  /**
   * Our own client purely so shutdown has something to flush. The wrapper would
   * otherwise use a lazily-created internal one with no handle to await.
   */
  private readonly client: Client | null;

  // Deliberately in the constructor rather than `onModuleInit`: `LlmModule`'s
  // factory builds the provider chain (and calls `wrapClient`) during module
  // instantiation, which happens before any lifecycle hook fires. Nest constructs
  // dependencies first, so doing the work here is what guarantees the environment
  // is set before anything reads it.
  constructor(private readonly config: AppConfigService) {
    this.enabled = config.langsmithTracing;

    if (!this.enabled) {
      // Set explicitly rather than left alone: a stray `LANGSMITH_TRACING=true` in
      // the ambient shell would otherwise re-enable tracing that this app's own
      // validated config says is off.
      process.env.LANGSMITH_TRACING = 'false';
      this.client = null;
      return;
    }

    process.env.LANGSMITH_TRACING = 'true';
    process.env.LANGSMITH_API_KEY = config.langsmithApiKey;
    process.env.LANGSMITH_PROJECT = config.langsmithProject;
    process.env.LANGSMITH_ENDPOINT = config.langsmithEndpoint;

    this.client = new Client({
      apiKey: config.langsmithApiKey,
      apiUrl: config.langsmithEndpoint,
    });

    this.logger.log(`LangSmith tracing enabled — project "${config.langsmithProject}"`);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Returns a client whose completions are traced as child runs of whatever graph
   * node is executing, or the client untouched when tracing is off.
   *
   * The return type stays `OpenAI` so callers are unaware of the difference —
   * `wrapOpenAI` preserves the call signatures and only adds an optional
   * `langsmithExtra` argument that nothing here passes.
   */
  wrapClient(client: OpenAI): OpenAI {
    if (!this.enabled || !this.client) return client;
    return wrapOpenAI(client, { client: this.client });
  }

  /**
   * Wraps one retrieval call so it appears as a child of the graph node that made
   * it.
   *
   * Needed for the same reason as `wrapClient`: the tools are plain functions
   * rather than LangChain runnables, so LangGraph has no idea they exist and the
   * trace shows `execute` as a leaf — the middle level of PLAN.md §5/M3.1's
   * "planner → tool → LLM" simply missing. `run_type: 'retriever'` because that
   * is what these are, and LangSmith renders retriever runs with their documents.
   *
   * Returns the function untouched when tracing is off, so the non-traced path
   * carries no wrapper at all.
   */
  traceTool<TArgs extends unknown[], TResult>(
    name: string,
    run: (...args: TArgs) => Promise<TResult>,
  ): (...args: TArgs) => Promise<TResult> {
    if (!this.enabled || !this.client) return run;

    // `TraceableFunction` adds an overload taking a RunTree as its first argument,
    // which TypeScript cannot reconcile with a generic `(...args: TArgs)`. No
    // caller uses that overload, so narrow back to the signature we handed in.
    return traceable(run, { name, run_type: 'retriever', client: this.client }) as unknown as (
      ...args: TArgs
    ) => Promise<TResult>;
  }

  /**
   * Traces are batched in the background, so a process that exits promptly loses
   * whatever had not been posted yet — which is exactly the run someone just made
   * before hitting Ctrl-C.
   */
  async onApplicationShutdown(): Promise<void> {
    if (!this.enabled || !this.client) return;

    try {
      // Two queues, two flushes: `awaitAllCallbacks` drains LangGraph's callback
      // handlers, `awaitPendingTraceBatches` drains the wrapper's own batches.
      await awaitAllCallbacks();
      await this.client.awaitPendingTraceBatches();
    } catch (error) {
      // Losing traces must never turn a clean shutdown into a failed one.
      this.logger.warn(
        `Could not flush pending LangSmith traces: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}

import { Logger } from '@nestjs/common';
import OpenAI from 'openai';
import type { AppConfigService, LlmProvider } from '../../config/app-config.service';
import { resolveBaseUrl, resolveModel } from './model-tiers';
import type { ChatMessage, ChatOptions, ChatResult, ChatTier, LlmService } from './llm.types';

/**
 * Raised when a provider refuses on quota. Typed rather than string-matched so the
 * failover chain can tell "this provider is out of budget, try the next one" from
 * "the request itself is malformed", which no amount of failover will fix.
 */
export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

/**
 * One OpenAI-compatible client, pointed at one provider.
 *
 * Deliberately *not* `@Injectable()`: a fallback chain needs several of these, one
 * per provider, so they are constructed by the factory in `llm.module.ts` rather
 * than resolved from the container. This is the same pattern `embeddings.module.ts`
 * already uses, and it is still not a module-level singleton — nothing is
 * instantiated at import time.
 *
 * Note this remains a *single* client class parameterised by provider, not a class
 * per vendor. PLAN.md §2's anti-goal is per-vendor provider classes plus a router;
 * failover across configured providers is what §9 explicitly asks for.
 */
export class OpenAICompatibleProvider implements LlmService {
  private readonly logger = new Logger(OpenAICompatibleProvider.name);
  private readonly client: OpenAI;

  constructor(
    private readonly config: AppConfigService,
    readonly provider: LlmProvider,
    apiKey: string,
    /**
     * Tier→model overrides apply only to the primary provider: `LLM_MODEL_FAST`
     * names a model on *that* provider, and forcing it onto a fallback would ask
     * Groq for a Gemini model id.
     */
    private readonly useModelOverrides: boolean,
  ) {
    const baseURL = resolveBaseUrl(provider, this.config.ollamaUrl);

    this.client = new OpenAI({
      baseURL,
      apiKey,
      // Keep this low. Retries beat a transient 5xx, but every attempt also counts
      // against a free tier's quota, so retrying hard into a 429 exhausts the
      // window faster. Surviving quota is the failover chain's job, not this one's.
      maxRetries: this.config.llmMaxRetries,
    });
    this.logger.log(`LLM provider: ${provider} (${baseURL})`);
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const tier = options.tier ?? 'default';
    const model = resolveModel(
      this.provider,
      tier,
      this.useModelOverrides
        ? {
            fast: this.config.llmModelFast,
            default: this.config.llmModelDefault,
            deep: this.config.llmModelDeep,
          }
        : {},
    );

    const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    if (options.system) {
      openaiMessages.push({ role: 'system', content: options.system });
    }

    for (const msg of messages) {
      openaiMessages.push({ role: msg.role, content: msg.content });
    }

    const start = Date.now();

    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model,
      messages: openaiMessages,
      temperature: options.temperature ?? 0,
      max_tokens: options.maxTokens,
    };

    if (options.jsonSchema) {
      params.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'response',
          schema: options.jsonSchema,
          strict: true,
        },
      };
    }

    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = await this.client.chat.completions.create(params, {
        signal: options.signal,
      });
    } catch (error) {
      throw this.describeFailure(error, model, tier);
    }

    const latencyMs = Date.now() - start;
    const choice = response.choices[0];
    const text = choice?.message?.content ?? '';
    const usage = response.usage;

    this.logger.debug(`[${tier}] ${model} — ${usage?.total_tokens ?? '?'} tokens, ${latencyMs}ms`);

    return {
      text,
      model: response.model ?? model,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
      },
      latencyMs,
      costUsd: null, // TODO: per-model cost table
    };
  }

  /**
   * Turns an SDK error into something a caller can act on.
   *
   * A quota failure otherwise surfaces as the bare string "429 status code (no
   * body)" — true, and useless. Which provider, which model, and *that it is a
   * quota problem rather than a bug* is what the person reading the SSE stream
   * or the eval log actually needs.
   */
  private describeFailure(error: unknown, model: string, tier: ChatTier): Error {
    if (error instanceof OpenAI.APIError && error.status === 429) {
      return new QuotaExceededError(
        `${this.provider} rate limit reached for ${model} (tier "${tier}"). Free tiers cap ` +
          `requests per window and one agent run makes several calls — wait for the window to ` +
          `reset, or configure LLM_FALLBACK_PROVIDERS so the run continues on another provider.`,
      );
    }
    if (error instanceof OpenAI.APIError && error.status === 404) {
      return new Error(
        `${this.provider} has no model "${model}" (tier "${tier}"). Model ids are ` +
          `retired over time — check the provider's model list and update src/ai/llm/model-tiers.ts.`,
      );
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

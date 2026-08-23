import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { AppConfigService } from '../../config/app-config.service';
import { resolveBaseUrl, resolveModel } from './model-tiers';
import type { ChatMessage, ChatOptions, ChatResult, LlmService } from './llm.types';

@Injectable()
export class OpenAICompatibleProvider implements LlmService {
  private readonly logger = new Logger(OpenAICompatibleProvider.name);
  private readonly client: OpenAI;

  constructor(private readonly config: AppConfigService) {
    const provider = this.config.llmProvider;
    const baseURL = resolveBaseUrl(provider, this.config.ollamaUrl);
    const apiKey = provider === 'ollama' ? 'ollama' : this.config.llmApiKey;

    if (!apiKey && provider !== 'ollama') {
      throw new Error(`LLM_API_KEY is required when LLM_PROVIDER=${provider}`);
    }

    this.client = new OpenAI({ baseURL, apiKey: apiKey ?? '' });
    this.logger.log(`LLM provider: ${provider} (${baseURL})`);
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const tier = options.tier ?? 'default';
    const model = resolveModel(this.config.llmProvider, tier, {
      fast: this.config.llmModelFast,
      default: this.config.llmModelDefault,
      deep: this.config.llmModelDeep,
    });

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

    const response = await this.client.chat.completions.create(params, {
      signal: options.signal,
    });

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
}

import type { LlmProvider } from '../../config/app-config.service';

export type ChatTier = 'fast' | 'default' | 'deep';

export interface ChatOptions {
  system?: string;
  temperature?: number;
  maxTokens?: number;
  tier?: ChatTier;
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  /**
   * Which provider actually served this call. Not always the configured primary:
   * `FailoverLlmService` moves down the chain on quota, so a single run can be
   * served by two vendors and the UI's run stats have to be able to say so.
   */
  provider: LlmProvider;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
  costUsd: number | null;
}

export interface LlmService {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

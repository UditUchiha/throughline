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

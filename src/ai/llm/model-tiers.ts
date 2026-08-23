import type { ChatTier } from './llm.types';
import type { LlmProvider } from '../../config/app-config.service';

type TierMap = Record<ChatTier, string>;

const PROVIDER_TIERS: Record<LlmProvider, TierMap> = {
  gemini: {
    fast: 'gemini-2.0-flash-lite',
    default: 'gemini-2.5-flash',
    deep: 'gemini-2.5-pro',
  },
  groq: {
    fast: 'llama-3.1-8b-instant',
    default: 'llama-3.3-70b-versatile',
    deep: 'llama-3.3-70b-versatile',
  },
  openrouter: {
    fast: 'meta-llama/llama-3.1-8b-instruct:free',
    default: 'meta-llama/llama-3.3-70b-instruct',
    deep: 'meta-llama/llama-3.3-70b-instruct',
  },
  ollama: {
    fast: 'qwen3.5:9b',
    default: 'qwen3.5:9b',
    deep: 'qwen3.5:9b',
  },
};

const PROVIDER_BASE_URLS: Record<LlmProvider, string> = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://localhost:11434/v1',
};

export function resolveModel(
  provider: LlmProvider,
  tier: ChatTier,
  overrides: { fast?: string; default?: string; deep?: string },
): string {
  return overrides[tier] ?? PROVIDER_TIERS[provider][tier];
}

export function resolveBaseUrl(provider: LlmProvider, ollamaUrl?: string): string {
  if (provider === 'ollama' && ollamaUrl) return `${ollamaUrl}/v1`;
  return PROVIDER_BASE_URLS[provider];
}

import type { ChatTier } from './llm.types';
import type { LlmProvider } from '../../config/app-config.service';

type TierMap = Record<ChatTier, string>;

// Model ids are perishable — Google retired `gemini-2.0-flash-lite` and
// `text-embedding-004` out from under this map, and a stale id fails as a 404 at
// call time rather than at boot. Re-check against the provider's model list when
// calls start 404ing.
const PROVIDER_TIERS: Record<LlmProvider, TierMap> = {
  gemini: {
    fast: 'gemini-3.5-flash-lite',
    default: 'gemini-3.5-flash',
    // Not a mistake, and not the same choice as `default` for the same reason:
    // every Gemini pro model returns 429 on the free tier, and free deployment
    // is a hard project constraint (PLAN.md §9). The tier seam stays so a
    // billed key can point `LLM_MODEL_DEEP` at a pro model with no code change.
    deep: 'gemini-3.5-flash',
  },
  groq: {
    // Verified against Groq's /models list: the llama-3.x ids this map originally
    // carried have been retired. These three support strict `json_schema`, which
    // every node depends on — `groq/compound*` does not, so do not reach for it.
    fast: 'openai/gpt-oss-20b',
    default: 'openai/gpt-oss-120b',
    deep: 'openai/gpt-oss-120b',
  },
  openrouter: {
    // Unverified — no OpenRouter key has been exercised against this map. Check
    // the ids against the provider's model list before trusting them.
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

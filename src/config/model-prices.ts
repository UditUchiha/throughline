import type { LlmProvider } from './app-config.service';

/**
 * USD per 1M tokens, quoted the way every provider publishes it.
 *
 * Split input/output because the ratio is not incidental: output is 4–6x input on
 * every model here, and this agent is input-heavy (evidence blocks dominate the
 * prompt), so a blended rate would misstate a run's cost in the direction that
 * matters.
 */
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * Per-model list prices, keyed by the same `provider/model` string that
 * `run_finished.models` carries.
 *
 * **Verified 2026-09-05 against each provider's own pricing page** (sources on
 * each entry). They still rot: this repo already learned that model *ids* are
 * perishable — see `model-tiers.ts` — and prices are worse, because a stale id
 * fails loudly as a 404 while a stale price quietly reports a wrong number. The
 * first draft of this table was a generation out of date (it carried Gemini 2.5
 * rates under 3.5 ids) and understated every run by roughly 5x, which is exactly
 * the failure mode to expect here. Re-check rather than trust.
 *
 * Standard synchronous rates only. Batch (50% off) and cached input (typically
 * half) are deliberately not modelled — this agent uses neither, and a discount
 * that does not apply is just a wrong number.
 *
 * A model that is absent is priced `null`, not zero. That is the whole reason
 * `recordUsage` poisons a run's total to `null` on a single unpriced call: an
 * understated cost is worse than an absent one, because it looks like an answer.
 */
const MODEL_PRICES: Record<string, ModelPrice> = {
  // Gemini — the default provider (PLAN.md §11.3).
  // https://ai.google.dev/gemini-api/docs/pricing
  'gemini/gemini-3.5-flash-lite': { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  'gemini/gemini-3.5-flash': { inputPerMillion: 1.5, outputPerMillion: 9.0 },

  // Groq — the configured fallback. Note the model id itself contains a slash, so
  // these keys have three segments; nothing parses the key, it is matched whole.
  // https://console.groq.com/docs/model/openai/gpt-oss-120b
  'groq/openai/gpt-oss-20b': { inputPerMillion: 0.075, outputPerMillion: 0.3 },
  'groq/openai/gpt-oss-120b': { inputPerMillion: 0.15, outputPerMillion: 0.6 },

  // OpenRouter — the model *ids* here remain unverified (no key has ever been
  // exercised against them), but the prices were checked.
  // https://openrouter.ai/meta-llama/llama-3.3-70b-instruct
  'openrouter/meta-llama/llama-3.3-70b-instruct': {
    inputPerMillion: 0.1,
    outputPerMillion: 0.32,
  },
  // A `:free` endpoint is genuinely $0 — that is a fact about the endpoint, not a
  // missing price, so it is listed rather than left to the null path.
  'openrouter/meta-llama/llama-3.1-8b-instruct:free': {
    inputPerMillion: 0,
    outputPerMillion: 0,
  },
};

/**
 * Looks up a price, tolerating the id drift between what we asked for and what the
 * provider says it served.
 *
 * `ChatResult.model` is `response.model ?? model` — the id echoed back by the API,
 * which is not always the id we sent: Gemini prefixes `models/`, and providers
 * routinely resolve an alias to a dated build (`…-flash-002`). Matching only the
 * exact string would price a run as unknown for a model that is right there in the
 * table, so fall back to a prefix match on the alias.
 */
export function priceFor(provider: LlmProvider, model: string): ModelPrice | null {
  // Local inference has no per-token cost. This is a property of running the model
  // yourself, not a missing table entry, so it must not take the `null` path —
  // M3's acceptance criterion is that Ollama reports $0.00, not "not priced".
  if (provider === 'ollama') return { inputPerMillion: 0, outputPerMillion: 0 };

  const key = `${provider}/${normaliseModelId(model)}`;
  const exact = MODEL_PRICES[key];
  if (exact) return exact;

  // `gemini/gemini-3.5-flash-002` should price as `gemini/gemini-3.5-flash`. Longest
  // key first, so `…-flash-lite` never loses to the shorter `…-flash` prefix — that
  // mistake would price the cheaper model at 5x its real input rate.
  const alias = Object.keys(MODEL_PRICES)
    .filter((candidate) => key.startsWith(`${candidate}-`))
    .sort((a, b) => b.length - a.length)[0];

  return alias ? MODEL_PRICES[alias] : null;
}

function normaliseModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^models\//, '');
}

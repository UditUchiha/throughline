import { z } from 'zod';

const llmProviderEnum = z.enum(['gemini', 'groq', 'openrouter', 'ollama']).default('gemini');
const embeddingProviderEnum = z.enum(['gemini', 'ollama']).default('gemini');

export const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(5000),

    // --- LLM provider (chat completions) ---
    LLM_PROVIDER: llmProviderEnum,
    LLM_API_KEY: z.string().optional(),

    // Ordered fallback chain, tried left to right when the primary provider is out
    // of quota or unreachable. PLAN.md §9 asks for exactly this: "catch quota errors,
    // fall back to the next configured provider". Empty means no failover.
    LLM_FALLBACK_PROVIDERS: z
      .string()
      .default('')
      .transform((raw) =>
        raw
          .split(',')
          .map((name) => name.trim().toLowerCase())
          .filter(Boolean),
      )
      .pipe(z.array(llmProviderEnum.removeDefault())),

    // Per-provider keys, so a fallback chain can authenticate to each hop. The
    // provider actually in use falls back to LLM_API_KEY when its own key is absent,
    // which keeps a single-provider setup a one-variable affair.
    GEMINI_API_KEY: z.string().optional(),
    GROQ_API_KEY: z.string().optional(),
    OPENROUTER_API_KEY: z.string().optional(),
    LLM_MODEL_FAST: z.string().optional(),
    LLM_MODEL_DEFAULT: z.string().optional(),
    LLM_MODEL_DEEP: z.string().optional(),
    // Deliberately low. Retries help a transient 5xx or a dropped connection; they are
    // actively harmful against a *quota* 429, because every attempt counts against the
    // same small budget — measured on Gemini's free tier (limit 20), maxRetries=5 turned
    // one synthesis call into six and exhausted the window faster than not retrying.
    // Surviving a quota limit needs a fallback provider (PLAN.md §9), not persistence.
    LLM_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),

    // --- Embedding provider ---
    EMBEDDING_PROVIDER: embeddingProviderEnum,
    EMBEDDING_API_KEY: z.string().optional(),
    EMBEDDING_MODEL: z.string().min(1).default('bge-m3'),
    EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1024),

    // --- Ollama (used when LLM_PROVIDER=ollama or EMBEDDING_PROVIDER=ollama) ---
    OLLAMA_URL: z.url().default('http://localhost:11434'),
    CHAT_MODEL: z.string().min(1).default('qwen3.5:9b'),

    // --- Paths ---
    DATABASE_PATH: z.string().min(1).default('./database/app.db'),
    KNOWLEDGE_PATH: z.string().min(1).default('./corpus/generated'),
    PROMPTS_PATH: z.string().min(1).default('./prompts'),
    // Recorded agent runs, replayed over SSE for the §9 demo fallback and for
    // building the UI without spending model calls. Written by `pnpm capture:runs`.
    DEMO_RUNS_PATH: z.string().min(1).default('./fixtures/runs'),
    // The authored question set (PLAN.md §6). Served to the UI as one-click examples,
    // which §5/M2 calls non-optional: a visitor has no idea what this corpus contains.
    // Only the question and its category are ever served — see ExampleQuestionsService.
    CORPUS_QUESTIONS_PATH: z.string().min(1).default('./corpus/questions.yaml'),

    // --- Indexing ---
    REINDEX_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(30 * 60 * 1000),

    // --- Retrieval ---
    TOP_K: z.coerce.number().int().positive().default(5),
    // Measured in words, not characters — see the comment on chunkText().
    CHUNK_SIZE: z.coerce.number().int().positive().default(700),
    CHUNK_OVERLAP: z.coerce.number().int().nonnegative().default(150),

    // NOT CURRENTLY ENFORCED. `RetrievalService.search` returns top-K regardless of
    // distance; nothing reads this value.
    //
    // Left in place rather than deleted because the methodology to make it real is
    // already written up in docs/retrieval-threshold-study.md — but that study derived
    // 0.902 for `bge-m3` at 1024 dimensions, and the default provider is now
    // `gemini-embedding-001` at 768. The study's own conclusion is that a distance
    // threshold is *not portable across embedding models*, and it documents a previous
    // outage caused by exactly that. So enforcing this number today would reproduce the
    // bug the study exists to prevent. Re-derive it against the current model in M6,
    // where the eval harness can measure the trade-off, then wire it up.
    RETRIEVAL_DISTANCE_THRESHOLD: z.coerce.number().nonnegative().default(0.9),

    // --- Agent ---
    MAX_HOPS: z.coerce.number().int().nonnegative().default(2),
    MAX_FAN_OUT: z.coerce.number().int().positive().default(5),

    // Total wall-clock budget for one agent run. The graph aborts in-flight model
    // calls and drains rather than letting a slow provider hang an SSE stream open.
    AGENT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60 * 1000),
  })
  .refine((env) => env.CHUNK_OVERLAP < env.CHUNK_SIZE, {
    message: 'CHUNK_OVERLAP must be smaller than CHUNK_SIZE',
  });

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${result.error.message}`);
  }
  return result.data;
}

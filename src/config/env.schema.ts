import { z } from 'zod';

const llmProviderEnum = z.enum(['gemini', 'groq', 'openrouter', 'ollama']).default('gemini');
const embeddingProviderEnum = z.enum(['gemini', 'ollama']).default('gemini');

// `z.coerce.boolean()` is not usable for env flags: it follows JS truthiness, so the
// string "false" coerces to `true`. Enumerating the accepted spellings instead means a
// typo fails at boot with a readable message rather than silently enabling something.
const envBoolean = z
  .string()
  .default('false')
  .transform((raw) => raw.trim().toLowerCase())
  .pipe(z.enum(['true', 'false', '1', '0']))
  .transform((value) => value === 'true' || value === '1');

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

    // --- Observability (PLAN.md §5/M3) ---

    // LangGraph and the LangSmith OpenAI wrapper both read these from `process.env`
    // themselves, so `LangSmithTracing` copies them back out of here at boot. They are
    // declared in this schema anyway — that is what keeps §0.3's "no process.env outside
    // src/config" true rather than nominally true, and it means a malformed value fails
    // at boot instead of silently disabling tracing.
    // How many finished runs the local trace store keeps. Oldest are pruned on
    // write. There is deliberately no "unlimited": the in-memory store this
    // replaced was capped at 100 and emptied on restart, so making it durable
    // without a bound would have quietly turned a bounded buffer into a log that
    // grows forever — and §9 bakes `database/app.db` into the deployed image, so
    // whatever accumulated during development would ship with it. A run costs
    // roughly 25–50KB here, almost all of it the evidence text carried on
    // `evidence_added`, so 200 is a handful of megabytes at worst.
    TRACE_RETENTION_RUNS: z.coerce.number().int().positive().default(200),

    LANGSMITH_TRACING: envBoolean,
    LANGSMITH_API_KEY: z.string().optional(),
    LANGSMITH_PROJECT: z.string().min(1).default('throughline'),
    LANGSMITH_ENDPOINT: z.url().default('https://api.smith.langchain.com'),
  })
  .refine((env) => env.CHUNK_OVERLAP < env.CHUNK_SIZE, {
    message: 'CHUNK_OVERLAP must be smaller than CHUNK_SIZE',
  })
  // Tracing without a key is the failure mode worth catching at boot: LangSmith's
  // client drops traces silently when it cannot authenticate, so the symptom is an
  // empty project half an hour later rather than an error at the call site.
  .refine((env) => !env.LANGSMITH_TRACING || Boolean(env.LANGSMITH_API_KEY), {
    message: 'LANGSMITH_TRACING is enabled but LANGSMITH_API_KEY is not set',
    path: ['LANGSMITH_API_KEY'],
  });

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${result.error.message}`);
  }
  return result.data;
}

import { z } from 'zod';

const llmProviderEnum = z.enum(['gemini', 'groq', 'openrouter', 'ollama']).default('gemini');
const embeddingProviderEnum = z.enum(['gemini', 'ollama']).default('gemini');

export const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(5000),

    // --- LLM provider (chat completions) ---
    LLM_PROVIDER: llmProviderEnum,
    LLM_API_KEY: z.string().optional(),
    LLM_MODEL_FAST: z.string().optional(),
    LLM_MODEL_DEFAULT: z.string().optional(),
    LLM_MODEL_DEEP: z.string().optional(),

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

    // --- Indexing ---
    REINDEX_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(30 * 60 * 1000),

    // --- Retrieval ---
    TOP_K: z.coerce.number().int().positive().default(5),
    CHUNK_SIZE: z.coerce.number().int().positive().default(700),
    CHUNK_OVERLAP: z.coerce.number().int().nonnegative().default(150),

    // sqlite-vec distance (lower = more similar) below which the best-matching chunk is
    // considered a confident grounding. See docs/retrieval-threshold-study.md for the
    // methodology behind this default and how to re-derive it for a different corpus or
    // embedding model — it is not portable across either.
    RETRIEVAL_DISTANCE_THRESHOLD: z.coerce.number().nonnegative().default(0.9),

    // --- Agent ---
    MAX_HOPS: z.coerce.number().int().nonnegative().default(2),
    MAX_FAN_OUT: z.coerce.number().int().positive().default(5),
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

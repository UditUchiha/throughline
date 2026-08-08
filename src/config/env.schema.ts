import { z } from 'zod';

export const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(5000),

    OLLAMA_URL: z.url().default('http://localhost:11434'),
    CHAT_MODEL: z.string().min(1).default('qwen3.5:9b'),
    // bge-m3 is multilingual (1024-dim). Changing the embedding model or its dimension
    // requires deleting database/app.db so the vec_chunks table is recreated at the new
    // size (see migrations.ts).
    EMBEDDING_MODEL: z.string().min(1).default('bge-m3'),
    EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1024),

    DATABASE_PATH: z.string().min(1).default('./database/app.db'),
    KNOWLEDGE_PATH: z.string().min(1).default('./corpus/generated'),
    PROMPTS_PATH: z.string().min(1).default('./prompts'),

    REINDEX_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(30 * 60 * 1000),

    TOP_K: z.coerce.number().int().positive().default(5),
    CHUNK_SIZE: z.coerce.number().int().positive().default(700),
    CHUNK_OVERLAP: z.coerce.number().int().nonnegative().default(150),

    // sqlite-vec distance (lower = more similar) below which the best-matching chunk is
    // considered a confident grounding. See docs/retrieval-threshold-study.md for the
    // methodology behind this default and how to re-derive it for a different corpus or
    // embedding model — it is not portable across either.
    RETRIEVAL_DISTANCE_THRESHOLD: z.coerce.number().nonnegative().default(0.9),
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

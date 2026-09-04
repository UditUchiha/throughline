import { z } from 'zod';

/**
 * A question is capped because the whole prompt chain is sized around corpus
 * questions, and an unbounded body would let one caller spend the run budget on
 * tokenising junk.
 */
export const askRequestSchema = z.object({
  question: z.string().trim().min(3).max(1000),
  /** Reuses an existing session so M4's memory can span turns. */
  sessionId: z.string().min(1).max(200).optional(),
});

export type AskRequest = z.infer<typeof askRequestSchema>;

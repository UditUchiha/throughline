import type { MemoryRef } from './agent.types';

/**
 * The `kind` given to a recalled conversation turn, as opposed to a durable
 * fact. Both travel on `memory_read` and both sit in `state.memoryUsed`, so this
 * string is what separates "what was said earlier in this session" from "what we
 * know about this person".
 */
export const SESSION_TURN_KIND = 'session_turn';

/** Long-term facts only — the session's own turns are not facts about anyone. */
export function rememberedFacts(memoryUsed: MemoryRef[]): MemoryRef[] {
  return memoryUsed.filter((ref) => ref.kind !== SESSION_TURN_KIND);
}

/**
 * Renders remembered facts for a prompt, or `null` when there are none.
 *
 * Null rather than an empty string so callers append nothing at all: a heading
 * over an empty list reads to a model as "we looked and found nothing about this
 * person", which is a claim, and it costs tokens to make it.
 */
export function renderMemoryBlock(memoryUsed: MemoryRef[]): string | null {
  const facts = rememberedFacts(memoryUsed);
  if (facts.length === 0) return null;

  return facts.map((fact) => `- (${fact.kind}) ${fact.text}`).join('\n');
}

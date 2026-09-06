import { Controller, Get, Inject } from '@nestjs/common';
import { MEMORY_REPOSITORY } from '../repositories/ports/tokens';
import type { MemoryRepository } from '../repositories/ports/memory.repository';
import { retentionRate, type MemoryFunnel } from './memory.types';

export interface MemoryStats {
  funnel: MemoryFunnel;
  /**
   * `stored / proposed`, or null before anything has been proposed. Null rather
   * than 0 because "nothing has happened yet" and "it keeps nothing" are very
   * different claims to put in a README.
   */
  retentionRate: number | null;
  /** Facts alive right now — lower than `funnel.stored` once decay has run. */
  factCount: number;
}

/**
 * Exposes the retention funnel (PLAN.md §5/M4.2).
 *
 * The counters are the interesting output of a memory system: "the system stores
 * roughly N% of what it could" is a claim someone can check, where "it has
 * memory" is not. The endpoint exists so the README's number has a source rather
 * than being copied from a one-off script.
 *
 * The facts themselves are deliberately **not** served. This is a public demo
 * over a shared corpus, and an endpoint listing everything the agent has ever
 * decided to remember about its visitors is a different thing entirely.
 */
@Controller('memory')
export class MemoryController {
  constructor(@Inject(MEMORY_REPOSITORY) private readonly facts: MemoryRepository) {}

  @Get('stats')
  async stats(): Promise<MemoryStats> {
    const funnel = await this.facts.funnel();
    return {
      funnel,
      retentionRate: retentionRate(funnel),
      factCount: await this.facts.countFacts(),
    };
  }
}

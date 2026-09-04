import type { RetrievedChunk } from '../../rag/retrieved-chunk.type';

export interface AgentToolInput {
  query: string;
  topK?: number;
  /**
   * The run's deadline. Plumbing rather than domain surface, but it has to travel
   * with the call: without it a hung tool outlives `AGENT_TIMEOUT_MS`, since the
   * graph can only check the signal *between* tool batches.
   */
  signal?: AbortSignal;
}

/**
 * The uniform tool shape (PLAN.md §4).
 *
 * Whether an implementation hits the local sqlite-vec index (M1–M4) or a live
 * MCP server (M5) is invisible to the graph. Keeping this interface narrow is
 * what makes M5 an additive change instead of a rewrite, so resist widening it
 * for the convenience of any single implementation.
 */
export interface AgentTool {
  readonly name: string;
  /** Shown verbatim to the planner — write it for the model, not for humans. */
  readonly description: string;
  /** JSON Schema for `AgentToolInput`, forwarded to structured-output calls. */
  readonly inputSchema: Record<string, unknown>;
  execute(input: AgentToolInput): Promise<RetrievedChunk[]>;
}

export const AGENT_TOOLS = Symbol('AGENT_TOOLS');

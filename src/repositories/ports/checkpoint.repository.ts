/**
 * Retention for the LangGraph checkpoints that back short-term memory.
 *
 * Reading and writing checkpoints is `SqliteSaver`'s job, not this port's — the
 * graph talks to the saver directly, and reimplementing that here would be an
 * abstraction over a dependency that already has one (§0.4). What the saver has
 * no opinion about is *forgetting*, and forgetting is the part M4 calls the
 * interesting engineering: a checkpoint is written on every superstep, so a
 * saver left alone turns a session store into an append-only log of every
 * intermediate state the agent has ever been in.
 */
export interface CheckpointRepository {
  /**
   * Drops every session but the `limit` most recently written to. Returns how
   * many sessions were dropped, so the caller can log a number rather than a
   * claim.
   */
  pruneToRecentSessions(limit: number): Promise<number>;
}

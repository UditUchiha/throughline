import type { Provider } from '@nestjs/common';
import type Database from 'better-sqlite3';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { SQLITE_CONNECTION } from '../../database/database.constants';

export const AGENT_CHECKPOINTER = Symbol('AgentCheckpointer');

/**
 * The LangGraph checkpointer backing short-term memory (PLAN.md §5/M4.1).
 *
 * **Why this is not behind a repository port.** §0.3's rule is that business
 * logic depends on `src/repositories/ports/` rather than on sqlite. A
 * checkpointer is not business logic reaching for a database — it is LangGraph
 * infrastructure, the same category as the compiled graph itself, and its
 * interface is `BaseCheckpointSaver`, which is already the port. Wrapping a
 * ready-made abstraction in a second one would be the §0.4 violation, not this.
 * Forgetting *is* ours, and that has a port: `CheckpointRepository`.
 *
 * **Why it shares the connection.** `SqliteSaver.fromConnString()` would open a
 * second handle on the same file, which is how you get two writers on one WAL
 * and a `SQLITE_BUSY` under concurrency for no gain. Injecting the existing
 * connection also means the checkpoint tables land in the same `app.db` that §9
 * bakes into the image, and inherit the pragmas `DatabaseModule` sets.
 *
 * The saver creates its own `checkpoints` and `writes` tables lazily on first
 * use, so they are deliberately absent from `migrations.ts` — see
 * `SqliteCheckpointRepository` for what that implies for pruning.
 */
export const agentCheckpointerProvider: Provider = {
  provide: AGENT_CHECKPOINTER,
  useFactory: (db: Database.Database): BaseCheckpointSaver => new SqliteSaver(db),
  inject: [SQLITE_CONNECTION],
};

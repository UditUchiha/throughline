import { Injectable } from '@nestjs/common';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { LongTermMemoryService } from '../../memory/long-term-memory.service';
import type { MemoryFact } from '../../memory/memory.types';
import type { MemoryRef } from '../agent.types';
import { createEmitter, getRunContext } from '../agent-run-context';
import type { AgentState, AgentStateUpdate } from '../state';

/**
 * Runs the long-term memory funnel over the finished exchange (PLAN.md §5/M4.2).
 *
 * **Placed after `synthesize`, not before it.** Extraction needs the answer, and
 * putting it on the path *before* the answer streams would make every visitor
 * wait on a model call that has nothing to do with their question. Here, the
 * answer has already gone out as `token_delta` and the UI is rendering it; only
 * `run_finished` — the stats block — waits.
 *
 * The session turn is committed by `synthesize` rather than here, deliberately:
 * short-term memory must survive this node failing, and a turn written one node
 * earlier is a turn already in the checkpoint.
 */
@Injectable()
export class RememberNode {
  constructor(private readonly memory: LongTermMemoryService) {}

  async run(state: AgentState, config: LangGraphRunnableConfig): Promise<AgentStateUpdate> {
    const { emit, events } = createEmitter(config);
    const { runId, sessionId, signal } = getRunContext(config);

    // Nothing to learn from a run that produced no answer, and an abstention
    // says something about the corpus rather than about the person asking.
    if (!state.answer || state.answer.abstained) return {};
    // The budget is spent — the caller has hung up or the run timed out. The
    // answer is already delivered; a model call here could only fail.
    if (signal.aborted) return {};

    const { stored, merged } = await this.memory.remember(
      {
        // The literal utterance, not the resolved rewrite: extraction is looking
        // for what the *person* said about themselves, and the rewrite is our
        // words, assembled from earlier turns.
        question: state.askedQuestion || state.question,
        answer: state.answer.text,
      },
      { runId, sessionId },
      signal,
    );

    const refs = [...stored.map(toRef('stored')), ...merged.map(toRef('restated'))];
    if (refs.length === 0) return {};

    emit({ type: 'memory_written', refs });
    return { events };
  }
}

/**
 * A merged fact is reported too, and labelled as a restatement.
 *
 * It is not a new row, but the run did change memory — it is the increment that
 * M4's "stating the same fact twice produces one stored fact with an incremented
 * counter" criterion is about, and a panel that showed nothing would suggest the
 * run had been ignored.
 */
function toRef(outcome: 'stored' | 'restated'): (fact: MemoryFact) => MemoryRef {
  return (fact) => ({
    id: `fact-${fact.id}`,
    kind: outcome === 'stored' ? fact.kind : `${fact.kind} · restated ×${fact.accessCount}`,
    text: fact.text,
  });
}

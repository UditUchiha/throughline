import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { ChatResult, LlmService } from '../../ai/llm/llm.types';
import { AGENT_RUN_CONTEXT, type AgentRunContext } from '../agent-run-context';
import type { AgentAnswer, Evidence, MemoryRef } from '../agent.types';
import type { EmittedAgentEvent } from '../events';
import type { AgentState, AgentStateUpdate } from '../state';
import { SynthesizeNode } from './synthesize.node';

function stubLlm(payload: object | string): { llm: LlmService; prompts: string[] } {
  const prompts: string[] = [];
  const llm: LlmService = {
    chat: (messages) => {
      prompts.push(messages.map((message) => message.content).join('\n'));
      const result: ChatResult = {
        text: typeof payload === 'string' ? payload : JSON.stringify(payload),
        provider: 'gemini',
        model: 'stub',
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 0,
        costUsd: null,
      };
      return Promise.resolve(result);
    },
  };
  return { llm, prompts };
}

function graphConfig(): { config: LangGraphRunnableConfig; emitted: EmittedAgentEvent[] } {
  const emitted: EmittedAgentEvent[] = [];
  const context: AgentRunContext = {
    runId: 'run-1',
    sessionId: 'session-1',
    sink: (event) => emitted.push(event),
    signal: new AbortController().signal,
    counter: { seq: 0 },
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    models: [],
    spans: [],
    rootSpanId: 'span-root',
    activeNodeSpanId: null,
  };
  return { config: { configurable: { [AGENT_RUN_CONTEXT]: context } }, emitted };
}

function evidence(chunkId: number): Evidence {
  return {
    evidenceId: `ev-${chunkId}`,
    docId: `doc-${chunkId}`,
    source: 'mail',
    title: `Article ${chunkId}`,
    text: `Passage ${chunkId}`,
    distance: 0.1 * chunkId,
    retrievedBy: 'sq1',
    tool: 'mail_search',
  };
}

const REMEMBERED: MemoryRef = {
  id: 'fact-4',
  kind: 'relationship',
  text: 'The user works on the Helios billing migration.',
};

const SESSION_TURN: MemoryRef = {
  id: 'turn-1',
  kind: 'session_turn',
  text: 'Why did it slip? — because load testing failed.',
};

function state(overrides: Partial<AgentState> = {}): AgentState {
  return {
    question: 'Did it ship on time?',
    askedQuestion: 'Did it ship on time?',
    sessionId: 'session-1',
    runId: 'run-1',
    complexity: 'simple',
    subQuestions: [],
    evidence: [evidence(1), evidence(2)],
    memoryUsed: [],
    hops: 1,
    answer: null,
    events: [],
    turns: [],
    ...overrides,
  };
}

/**
 * Narrows the answer off a state update.
 *
 * `AgentStateUpdate['answer']` is a union with LangGraph's `OverwriteValue`,
 * because the channel takes `null` as its reset signal (see `perTurn` in
 * state.ts). Narrowing rather than casting keeps §0.3's "no raw type casts"
 * honest, and a node that returned no answer fails loudly here instead of
 * silently satisfying an `?.` chain.
 */
function answerOf(update: AgentStateUpdate): AgentAnswer {
  const { answer } = update;
  if (!answer || typeof answer !== 'object' || !('text' in answer)) {
    throw new Error(`Expected the node to return an answer, got ${JSON.stringify(answer)}`);
  }
  return answer;
}

describe('SynthesizeNode', () => {
  it('resolves the markers it was shown', async () => {
    const { llm } = stubLlm({ answer: 'It shipped late [1][2].', abstained: false });
    const { config } = graphConfig();

    const update = await new SynthesizeNode(llm).run(state(), config);

    expect(answerOf(update).citations).toEqual([
      { marker: 1, evidenceId: 'ev-1' },
      { marker: 2, evidenceId: 'ev-2' },
    ]);
  });

  describe('remembered facts are context, never evidence', () => {
    /**
     * The property that justifies keeping long-term memory out of `vec_chunks`
     * entirely (PLAN.md §5/M4.2 deviation, and §4's citation commitment).
     *
     * `all_sources_search` passes no `sourceFilter`, so a fact stored in the
     * chunk index would be retrieved as corpus evidence and cited as though it
     * were a document. Facts therefore reach this node through a separate block
     * with no numbering — and these tests pin that the separation actually holds
     * where the two meet, rather than only in the comment that explains it.
     */
    it('puts a fact in the prompt but outside the numbered passages', async () => {
      const { llm, prompts } = stubLlm({ answer: 'It shipped late [1].', abstained: false });
      const { config } = graphConfig();

      await new SynthesizeNode(llm).run(state({ memoryUsed: [REMEMBERED] }), config);

      const [prompt] = prompts;
      expect(prompt).toContain('The user works on the Helios billing migration.');

      // The fact must sit after the passage block, not inside it: everything in
      // the passage block is numbered and therefore citable.
      const passages = prompt.indexOf('Passages:');
      const fact = prompt.indexOf('The user works on the Helios billing migration.');
      expect(passages).toBeGreaterThanOrEqual(0);
      expect(fact).toBeGreaterThan(passages);
      expect(prompt).toContain('never cite them');
    });

    it('strips a citation the model invented for a remembered fact', async () => {
      // Two passages were shown, so [3] can only be the model reaching for the
      // memory block. This is the failure the whole storage decision prevents,
      // and the mechanical backstop for it if a prompt ever stops holding.
      const { llm } = stubLlm({
        answer: 'It shipped late [1]. The user works on Helios [3].',
        abstained: false,
      });
      const { config } = graphConfig();

      const update = await new SynthesizeNode(llm).run(state({ memoryUsed: [REMEMBERED] }), config);

      const answer = answerOf(update);
      expect(answer.citations).toEqual([{ marker: 1, evidenceId: 'ev-1' }]);
      expect(answer.text).not.toContain('[3]');
      // Every surviving citation still resolves to a real retrieved chunk.
      const evidenceIds = state().evidence.map((piece) => piece.evidenceId);
      for (const citation of answer.citations) {
        expect(evidenceIds).toContain(citation.evidenceId);
      }
    });

    it('does not put the session transcript in front of the answer model', async () => {
      const { llm, prompts } = stubLlm({ answer: 'It shipped late [1].', abstained: false });
      const { config } = graphConfig();

      await new SynthesizeNode(llm).run(state({ memoryUsed: [SESSION_TURN, REMEMBERED] }), config);

      // `recall` already folded the conversation into the question itself.
      // Replaying the previous answer here would invite synthesis to reuse it as
      // though it were grounded in this run's evidence.
      expect(prompts[0]).not.toContain('because load testing failed');
      expect(prompts[0]).toContain('The user works on the Helios billing migration.');
    });

    it('adds no memory heading when nothing was recalled', async () => {
      const { llm, prompts } = stubLlm({ answer: 'It shipped late [1].', abstained: false });
      const { config } = graphConfig();

      await new SynthesizeNode(llm).run(state(), config);

      // A heading over an empty list reads as "we looked and found nothing about
      // this person" — a claim, and one that costs tokens to make.
      expect(prompts[0]).not.toContain('Remembered about the person asking');
    });
  });

  it('records the turn even with no evidence to answer from', async () => {
    const { llm } = stubLlm({ answer: 'unused', abstained: false });
    const { config, emitted } = graphConfig();

    const update = await new SynthesizeNode(llm).run(state({ evidence: [] }), config);

    expect(answerOf(update).abstained).toBe(true);
    // Short-term memory is committed here rather than in `remember`, so it
    // survives every exit from this node — including the ones that never call a
    // model.
    expect(update.turns).toHaveLength(1);
    expect(emitted.some((event) => event.type === 'memory_written')).toBe(true);
  });

  it('keeps what the visitor asked on the turn, alongside the resolved form', async () => {
    const { llm } = stubLlm({ answer: 'It shipped late [1].', abstained: false });
    const { config } = graphConfig();

    const update = await new SynthesizeNode(llm).run(
      state({ question: 'Did Helios ship on time?', askedQuestion: 'Did it ship on time?' }),
      config,
    );

    expect(update.turns?.[0]).toMatchObject({
      question: 'Did it ship on time?',
      standalone: 'Did Helios ship on time?',
    });
  });
});

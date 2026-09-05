import { UsageService } from './usage.service';

describe('UsageService', () => {
  const usage = () => new UsageService();

  it('prices a call from the per-model table', () => {
    // gemini-3.5-flash is $1.50/M in, $9.00/M out (verified 2026-09-05).
    const cost = usage().costOf('gemini', 'gemini-3.5-flash', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    expect(cost).toBeCloseTo(10.5, 10);
  });

  it('charges input and output at different rates', () => {
    const inputHeavy = usage().costOf('gemini', 'gemini-3.5-flash', {
      inputTokens: 100_000,
      outputTokens: 0,
    });
    const outputHeavy = usage().costOf('gemini', 'gemini-3.5-flash', {
      inputTokens: 0,
      outputTokens: 100_000,
    });

    // The ratio is the point: a blended rate would misstate this agent's cost,
    // because its prompts are evidence-heavy and its answers are short.
    expect(inputHeavy).toBeCloseTo(0.15, 10);
    expect(outputHeavy).toBeCloseTo(0.9, 10);
  });

  it('reports zero for a locally-served model rather than "unknown"', () => {
    // M3's acceptance criterion is $0.00 on Ollama. Free is a fact about local
    // inference, not a missing table entry, so it must not take the null path.
    expect(usage().costOf('ollama', 'qwen3.5:9b', { inputTokens: 5_000, outputTokens: 900 })).toBe(
      0,
    );
  });

  it('returns null for a model with no published price', () => {
    expect(
      usage().costOf('groq', 'some-model-nobody-priced', {
        inputTokens: 1_000,
        outputTokens: 1_000,
      }),
    ).toBeNull();
  });

  it('prices a dated build through its alias', () => {
    // Providers resolve an alias to a dated build and echo *that* back, so the id
    // in ChatResult is routinely not the id we asked for.
    const dated = usage().costOf('gemini', 'gemini-3.5-flash-002', {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });

    expect(dated).toBeCloseTo(1.5, 10);
  });

  it('does not let the flash alias swallow flash-lite', () => {
    // `gemini-3.5-flash-lite` starts with `gemini-3.5-flash-`, so a naive prefix
    // match prices it as the dearer model — 5x the real input rate.
    const lite = usage().costOf('gemini', 'gemini-3.5-flash-lite', {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });

    expect(lite).toBeCloseTo(0.3, 10);
  });

  it('tolerates the models/ prefix Gemini returns', () => {
    expect(
      usage().costOf('gemini', 'models/gemini-3.5-flash', {
        inputTokens: 1_000_000,
        outputTokens: 0,
      }),
    ).toBeCloseTo(1.5, 10);
  });

  it('prices a model whose id contains a slash', () => {
    // Groq's ids are namespaced (`openai/gpt-oss-20b`), so the table key has three
    // segments. Nothing may parse the key apart.
    expect(
      usage().costOf('groq', 'openai/gpt-oss-20b', { inputTokens: 1_000_000, outputTokens: 0 }),
    ).toBeCloseTo(0.075, 10);
  });
});

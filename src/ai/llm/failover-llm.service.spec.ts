import { APIError, APIUserAbortError } from 'openai';
import { FailoverLlmService } from './failover-llm.service';
import type { ChatResult } from './llm.types';
import { QuotaExceededError, type OpenAICompatibleProvider } from './openai-compatible.provider';

function result(model: string): ChatResult {
  return {
    text: `answer from ${model}`,
    provider: 'gemini',
    model,
    usage: { inputTokens: 1, outputTokens: 1 },
    latencyMs: 0,
    costUsd: null,
  };
}

/** A stand-in for one provider in the chain, recording whether it was consulted. */
function stubProvider(
  name: string,
  behaviour: 'ok' | Error,
): OpenAICompatibleProvider & { calls: number } {
  const stub = {
    provider: name,
    label: name,
    calls: 0,
    chat() {
      stub.calls++;
      if (behaviour === 'ok') return Promise.resolve(result(name));
      return Promise.reject(behaviour);
    },
  };
  return stub as unknown as OpenAICompatibleProvider & { calls: number };
}

function apiError(status: number): APIError {
  return new APIError(status, undefined, `HTTP ${status}`, undefined);
}

describe('FailoverLlmService', () => {
  it('uses the primary provider and never consults the fallback when it succeeds', async () => {
    const primary = stubProvider('gemini', 'ok');
    const fallback = stubProvider('groq', 'ok');

    const res = await new FailoverLlmService([primary, fallback]).chat([
      { role: 'user', content: 'hi' },
    ]);

    expect(res.model).toBe('gemini');
    expect(fallback.calls).toBe(0);
  });

  // The whole reason this class exists: a quota wall should cost a slower answer,
  // not a failed run.
  it('falls back to the next provider when the primary is out of quota', async () => {
    const primary = stubProvider('gemini', new QuotaExceededError('gemini rate limit reached'));
    const fallback = stubProvider('groq', 'ok');

    const res = await new FailoverLlmService([primary, fallback]).chat([
      { role: 'user', content: 'hi' },
    ]);

    expect(res.model).toBe('groq');
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
  });

  it('walks past several exhausted providers to reach a working one', async () => {
    const a = stubProvider('gemini', new QuotaExceededError('out'));
    const b = stubProvider('groq', new QuotaExceededError('out'));
    const c = stubProvider('openrouter', 'ok');

    const res = await new FailoverLlmService([a, b, c]).chat([{ role: 'user', content: 'hi' }]);

    expect(res.model).toBe('openrouter');
  });

  it('fails over on a server error, which is the provider being unwell', async () => {
    const primary = stubProvider('gemini', apiError(503));
    const fallback = stubProvider('groq', 'ok');

    const res = await new FailoverLlmService([primary, fallback]).chat([
      { role: 'user', content: 'hi' },
    ]);

    expect(res.model).toBe('groq');
  });

  // Asking a second hop the same malformed question just wastes time before
  // showing the same error, so these must not fail over.
  it.each([
    ['a bad request', 400],
    ['an unknown model', 404],
  ])('rethrows %s immediately without consulting the fallback', async (_label, status) => {
    const primary = stubProvider('gemini', apiError(status));
    const fallback = stubProvider('groq', 'ok');

    await expect(
      new FailoverLlmService([primary, fallback]).chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow(`HTTP ${status}`);
    expect(fallback.calls).toBe(0);
  });

  // Permission is a property of the credential, not of the request, so the next
  // hop may hold one that is allowed. This reversed an earlier rule that grouped
  // 401/403 with 400 — see `isRetryableProviderError`, and the eval pass those
  // two status codes killed.
  it.each([
    ['a rejected key', 401],
    ['a key without access to the model', 403],
  ])('fails over on %s', async (_label, status) => {
    const primary = stubProvider('gemini', apiError(status));
    const fallback = stubProvider('groq', 'ok');

    const res = await new FailoverLlmService([primary, fallback]).chat([
      { role: 'user', content: 'hi' },
    ]);

    expect(res.text).toBe('answer from groq');
    expect(fallback.calls).toBe(1);
  });

  it('reports every provider it tried when the whole chain is exhausted', async () => {
    const a = stubProvider('gemini', new QuotaExceededError('gemini rate limit reached'));
    const b = stubProvider('groq', new QuotaExceededError('groq rate limit reached'));

    await expect(
      new FailoverLlmService([a, b]).chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow(/Every configured LLM provider failed[\s\S]*gemini[\s\S]*groq/);
  });

  // Regression: APIUserAbortError extends APIError with status === undefined, so a
  // naive "no status means the provider is unwell" test treats a timeout as an
  // outage and reports "every provider failed" for a run the caller cancelled.
  it('does not fail over when the caller aborted the run', async () => {
    const primary = stubProvider('gemini', new APIUserAbortError());
    const fallback = stubProvider('groq', 'ok');

    await expect(
      new FailoverLlmService([primary, fallback]).chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toThrow(/aborted/i);
    expect(fallback.calls).toBe(0);
  });

  it('surfaces an abort as itself, not as a chain-exhausted error', async () => {
    const only = stubProvider('gemini', new APIUserAbortError());

    await expect(
      new FailoverLlmService([only]).chat([{ role: 'user', content: 'hi' }]),
    ).rejects.not.toThrow(/Every configured LLM provider failed/);
  });

  it('refuses to construct with no providers rather than failing at first use', () => {
    expect(() => new FailoverLlmService([])).toThrow(/No LLM provider is configured/);
  });
});

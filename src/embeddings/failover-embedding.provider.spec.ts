import { APIError, APIUserAbortError } from 'openai';
import {
  AllEmbeddingKeysFailedError,
  FailoverEmbeddingProvider,
} from './failover-embedding.provider';
import type { EmbeddingProvider } from './embedding.types';

/** A stand-in for one credential in the chain, recording whether it was used. */
function stubCredential(
  label: string,
  behaviour: 'ok' | Error,
): EmbeddingProvider & { label: string; calls: number } {
  const stub = {
    label,
    calls: 0,
    dimensions: 768,
    modelId: `gemini/gemini-embedding-001`,
    embed(texts: string[]) {
      stub.calls++;
      if (behaviour === 'ok') return Promise.resolve(texts.map(() => [1, 2, 3]));
      return Promise.reject(behaviour);
    },
  };
  return stub;
}

function apiError(status: number): APIError {
  return new APIError(status, undefined, `HTTP ${status}`, undefined);
}

describe('FailoverEmbeddingProvider', () => {
  it('uses the first credential and never consults the next when it succeeds', async () => {
    const first = stubCredential('gemini#1', 'ok');
    const second = stubCredential('gemini#2', 'ok');

    const vectors = await new FailoverEmbeddingProvider([first, second]).embed(['a']);

    expect(vectors).toHaveLength(1);
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(0);
  });

  // The measured failure: a rate-limited key must not end retrieval, because an
  // empty evidence set is not an error the agent can see.
  it('falls over to the next credential on a rate limit', async () => {
    const first = stubCredential('gemini#1', apiError(429));
    const second = stubCredential('gemini#2', 'ok');

    const vectors = await new FailoverEmbeddingProvider([first, second]).embed(['a', 'b']);

    expect(vectors).toHaveLength(2);
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(1);
  });

  it('falls over on a server error', async () => {
    const first = stubCredential('gemini#1', apiError(503));
    const second = stubCredential('gemini#2', 'ok');

    await expect(new FailoverEmbeddingProvider([first, second]).embed(['a'])).resolves.toHaveLength(
      1,
    );
    expect(second.calls).toBe(1);
  });

  // The failure that made this whole chain necessary: a key that answers chat but
  // is not permitted on the embeddings model. Permission belongs to the
  // credential, so the next one is worth trying.
  it.each([
    ['a rejected key', 401],
    ['a key without access to the model', 403],
  ])('falls over on %s', async (_label, status) => {
    const first = stubCredential('gemini#1', apiError(status));
    const second = stubCredential('gemini#2', 'ok');

    await expect(new FailoverEmbeddingProvider([first, second]).embed(['a'])).resolves.toHaveLength(
      1,
    );
    expect(second.calls).toBe(1);
  });

  // A malformed request follows the credential chain unchanged, so trying the
  // rest only delays the same error.
  it('rethrows a bad request instead of trying every other credential', async () => {
    const first = stubCredential('gemini#1', apiError(400));
    const second = stubCredential('gemini#2', 'ok');

    await expect(new FailoverEmbeddingProvider([first, second]).embed(['a'])).rejects.toThrow(
      'HTTP 400',
    );
    expect(second.calls).toBe(0);
  });

  it('does not treat a caller abort as a credential fault', async () => {
    const first = stubCredential('gemini#1', new APIUserAbortError());
    const second = stubCredential('gemini#2', 'ok');

    await expect(
      new FailoverEmbeddingProvider([first, second]).embed(['a']),
    ).rejects.toBeInstanceOf(APIUserAbortError);
    expect(second.calls).toBe(0);
  });

  it('throws once the chain is exhausted, naming each credential', async () => {
    const first = stubCredential('gemini#1', apiError(429));
    const second = stubCredential('gemini#2', apiError(429));

    const embed = new FailoverEmbeddingProvider([first, second]).embed(['a']);

    await expect(embed).rejects.toBeInstanceOf(AllEmbeddingKeysFailedError);
    await expect(embed).rejects.toThrow(/gemini#1[\s\S]*gemini#2/);
  });

  it('spends no credential on an empty input', async () => {
    const only = stubCredential('gemini#1', 'ok');

    await expect(new FailoverEmbeddingProvider([only]).embed([])).resolves.toEqual([]);
    expect(only.calls).toBe(0);
  });

  it('reports the identity of the model behind the chain', () => {
    const chain = new FailoverEmbeddingProvider([
      stubCredential('gemini#1', 'ok'),
      stubCredential('gemini#2', 'ok'),
    ]);

    expect(chain.dimensions).toBe(768);
    expect(chain.modelId).toBe('gemini/gemini-embedding-001');
  });

  it('refuses to exist with no credentials', () => {
    expect(() => new FailoverEmbeddingProvider([])).toThrow('No embedding credential');
  });
});

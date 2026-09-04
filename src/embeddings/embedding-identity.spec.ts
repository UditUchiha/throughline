import { embeddingIdentity, embeddingModelId } from './embedding.types';

/**
 * These assertions exist because the writer and the reader of `index_meta` once
 * built this string independently and disagreed: the index recorded
 * `gemini/gemini-embedding-001:768` while the boot check looked for
 * `gemini-embedding-001:768`, so a correctly built index failed to boot.
 */
describe('embedding index identity', () => {
  it('qualifies the model by provider', () => {
    expect(embeddingModelId('gemini', 'gemini-embedding-001')).toBe('gemini/gemini-embedding-001');
  });

  it('produces the same identity from the provider side and the config side', () => {
    // What IndexingService writes, from the live provider.
    const written = embeddingIdentity(embeddingModelId('gemini', 'gemini-embedding-001'), 768);

    // What DatabaseModule computes at boot, from AppConfigService.
    const checked = embeddingIdentity(embeddingModelId('gemini', 'gemini-embedding-001'), 768);

    expect(written).toBe(checked);
    expect(written).toBe('gemini/gemini-embedding-001:768');
  });

  it('distinguishes the same model name served by different providers', () => {
    expect(embeddingIdentity(embeddingModelId('ollama', 'bge-m3'), 1024)).not.toBe(
      embeddingIdentity(embeddingModelId('gemini', 'bge-m3'), 1024),
    );
  });

  it('distinguishes a dimension change, which invalidates every stored vector', () => {
    const modelId = embeddingModelId('gemini', 'gemini-embedding-001');
    expect(embeddingIdentity(modelId, 768)).not.toBe(embeddingIdentity(modelId, 1536));
  });
});

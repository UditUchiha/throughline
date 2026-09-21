import { ConfigService } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import type { EnvConfig } from './env.schema';

/**
 * A stand-in for the validated environment.
 *
 * Typed loosely on purpose: these tests are about how `AppConfigService` reads
 * the environment, and restating `EnvConfig` in full here would make every new
 * variable a change to this file.
 */
function configWith(values: Record<string, unknown>): AppConfigService {
  const service = {
    get: (key: string) => values[key],
  } as unknown as ConfigService<EnvConfig, true>;

  return new AppConfigService(service);
}

describe('AppConfigService key resolution', () => {
  describe('llmApiKeysFor', () => {
    it('returns a single key as a one-hop chain', () => {
      const config = configWith({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'key-a' });

      expect(config.llmApiKeysFor('gemini')).toEqual(['key-a']);
    });

    it('splits several comma-separated keys in order', () => {
      const config = configWith({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'key-a,key-b,key-c' });

      expect(config.llmApiKeysFor('gemini')).toEqual(['key-a', 'key-b', 'key-c']);
    });

    // These arrive by being pasted into a dashboard field, not typed into a file,
    // so the whitespace and the trailing separator are the expected input rather
    // than the pathological one.
    it('tolerates surrounding whitespace and a trailing separator', () => {
      const config = configWith({
        LLM_PROVIDER: 'gemini',
        GEMINI_API_KEY: ' key-a , key-b ,',
      });

      expect(config.llmApiKeysFor('gemini')).toEqual(['key-a', 'key-b']);
    });

    it('returns nothing when the provider has no key', () => {
      const config = configWith({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'key-a' });

      expect(config.llmApiKeysFor('groq')).toEqual([]);
    });

    it('accepts LLM_API_KEY for the primary provider only', () => {
      const config = configWith({ LLM_PROVIDER: 'gemini', LLM_API_KEY: 'shared-a,shared-b' });

      expect(config.llmApiKeysFor('gemini')).toEqual(['shared-a', 'shared-b']);
      // Handing the primary's key to a different vendor authenticates to the
      // wrong service and returns a 401 that reads like a bad key.
      expect(config.llmApiKeysFor('groq')).toEqual([]);
    });

    it('prefers the provider-specific key over LLM_API_KEY', () => {
      const config = configWith({
        LLM_PROVIDER: 'gemini',
        GEMINI_API_KEY: 'own-a',
        LLM_API_KEY: 'shared-a',
      });

      expect(config.llmApiKeysFor('gemini')).toEqual(['own-a']);
    });

    it('gives ollama a placeholder, since it is local and unauthenticated', () => {
      const config = configWith({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'key-a' });

      expect(config.llmApiKeysFor('ollama')).toEqual(['ollama']);
    });
  });

  describe('llmApiKeyFor', () => {
    it('is the first key of the chain', () => {
      const config = configWith({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'key-a,key-b' });

      expect(config.llmApiKeyFor('gemini')).toBe('key-a');
    });

    it('is undefined when nothing is configured', () => {
      const config = configWith({ LLM_PROVIDER: 'gemini' });

      expect(config.llmApiKeyFor('gemini')).toBeUndefined();
    });
  });
});

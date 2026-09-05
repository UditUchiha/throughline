import { validateEnv } from './env.schema';

const BASE = { LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key' };

describe('env schema — observability', () => {
  it('defaults tracing off, so a clone needs no extra account', () => {
    expect(validateEnv({ ...BASE }).LANGSMITH_TRACING).toBe(false);
  });

  it('reads "false" as false', () => {
    // `z.coerce.boolean()` follows JS truthiness, so it turns the *string* "false"
    // into `true`. Someone switching tracing off in .env would have switched it on.
    expect(validateEnv({ ...BASE, LANGSMITH_TRACING: 'false' }).LANGSMITH_TRACING).toBe(false);
    expect(validateEnv({ ...BASE, LANGSMITH_TRACING: '0' }).LANGSMITH_TRACING).toBe(false);
  });

  it('reads "true" and "1" as true', () => {
    const on = { ...BASE, LANGSMITH_API_KEY: 'ls-key' };
    expect(validateEnv({ ...on, LANGSMITH_TRACING: 'true' }).LANGSMITH_TRACING).toBe(true);
    expect(validateEnv({ ...on, LANGSMITH_TRACING: '1' }).LANGSMITH_TRACING).toBe(true);
  });

  it('tolerates casing and stray whitespace', () => {
    expect(
      validateEnv({ ...BASE, LANGSMITH_API_KEY: 'k', LANGSMITH_TRACING: ' TRUE ' })
        .LANGSMITH_TRACING,
    ).toBe(true);
  });

  it('refuses a value that is neither true nor false', () => {
    // Better to fail at boot than to guess. A typo silently meaning "off" is the
    // same class of bug as "false" silently meaning "on".
    expect(() => validateEnv({ ...BASE, LANGSMITH_TRACING: 'yes-please' })).toThrow();
  });

  it('refuses tracing without an API key', () => {
    // LangSmith drops traces silently when it cannot authenticate, so the
    // alternative symptom is an empty project noticed an hour later.
    expect(() => validateEnv({ ...BASE, LANGSMITH_TRACING: 'true' })).toThrow(
      /LANGSMITH_API_KEY is not set/,
    );
  });

  it('accepts tracing with a key, and defaults the project name', () => {
    const config = validateEnv({ ...BASE, LANGSMITH_TRACING: 'true', LANGSMITH_API_KEY: 'ls-key' });

    expect(config.LANGSMITH_TRACING).toBe(true);
    expect(config.LANGSMITH_PROJECT).toBe('throughline');
    expect(config.LANGSMITH_ENDPOINT).toBe('https://api.smith.langchain.com');
  });

  it('does not require a key when tracing is off', () => {
    expect(() => validateEnv({ ...BASE, LANGSMITH_TRACING: 'false' })).not.toThrow();
  });
});

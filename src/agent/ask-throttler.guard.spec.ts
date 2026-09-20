import { isDemoReplay, resolveTracker } from './ask-throttler.guard';

/**
 * `isDemoReplay` and `resolveTracker` are the two pieces of `AskThrottlerGuard`
 * actually worth pinning — the rest is `ThrottlerGuard` plumbing. This file
 * exists because `resolveTracker` didn't, until a live finding on 2026-09-20
 * showed the hop-counted `request.ip` alone is not a stable per-visitor identity
 * behind Render's actual topology (Cloudflare in front, an untrusted hop
 * `TRUST_PROXY_HOPS` never accounted for) — see the function's own comment for
 * the measurement.
 */
describe('isDemoReplay', () => {
  it('recognises both spellings a query string can produce', () => {
    expect(isDemoReplay('1')).toBe(true);
    expect(isDemoReplay('true')).toBe(true);
  });

  it('rejects anything else, including undefined and a near-miss', () => {
    expect(isDemoReplay(undefined)).toBe(false);
    expect(isDemoReplay('0')).toBe(false);
    expect(isDemoReplay('True')).toBe(false);
  });
});

describe('resolveTracker', () => {
  function request(headers: Record<string, string | string[]>, ip?: string) {
    return { ip, headers };
  }

  it('prefers CF-Connecting-IP when Cloudflare set it', () => {
    expect(resolveTracker(request({ 'cf-connecting-ip': '203.0.113.9' }, '10.0.0.5'))).toBe(
      '203.0.113.9',
    );
  });

  it('falls back to request.ip when there is no Cloudflare in front', () => {
    // Northflank, Cloud Run and a Docker Space never send this header — this is
    // the path that keeps the guard host-neutral rather than Cloudflare-only.
    expect(resolveTracker(request({}, '203.0.113.9'))).toBe('203.0.113.9');
  });

  it('ignores an empty header rather than bucketing every visitor together', () => {
    expect(resolveTracker(request({ 'cf-connecting-ip': '' }, '203.0.113.9'))).toBe('203.0.113.9');
  });

  it('does not trust an array-shaped header as a single identity', () => {
    // A duplicated header is not the shape Cloudflare's edge produces; treating
    // it as trustworthy anyway is how a client-controlled value would sneak in.
    expect(
      resolveTracker(request({ 'cf-connecting-ip': ['1.2.3.4', '5.6.7.8'] }, '203.0.113.9')),
    ).toBe('203.0.113.9');
  });

  it('falls back to "unknown" when neither is available', () => {
    expect(resolveTracker(request({}))).toBe('unknown');
  });
});

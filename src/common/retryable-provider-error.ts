import { APIConnectionError, APIError, APIUserAbortError } from 'openai';

/**
 * True when a failure is about *this credential's* availability rather than the
 * request — the question every failover chain has to answer.
 *
 * Extracted when embeddings gained a chain of their own: chat wraps a 429 into
 * `QuotaExceededError` before it gets here and embeddings do not, so the two
 * would have had to agree about raw SDK errors while holding separate copies of
 * the rule. They are the same rule.
 *
 * A 429 is the common case; 5xx and transport failures are the same class of
 * "try someone else". A 400 or 404 is not — a malformed request and an unknown
 * model follow the request to every hop, so trying them all just multiplies the
 * latency before showing the same error.
 *
 * **401 and 403 are retryable, and that reversed an earlier decision.** The
 * original rule grouped them with 400 on the reasoning that an auth failure
 * "follows the request wherever it goes". That was true when a hop meant a
 * different *vendor*; since keys became chains a hop is a different *credential*,
 * and permission is a property of the credential — precisely what the next one
 * might have. Measured on 2026-09-21: a Gemini key that answers chat returned 403
 * for the embeddings model, and because 403 stopped the chain, all 59 eval
 * questions failed against four further keys that were never tried.
 *
 * The diagnostic this used to protect is not lost. A chain that exhausts every
 * credential raises an error naming each one and why it refused, which is
 * strictly more informative than the bare 403 that replaced it.
 */
export function isRetryableProviderError(error: unknown): boolean {
  // Checked first, and it must be: `APIUserAbortError` extends `APIError` with
  // `status === undefined`, so the general test below would call it retryable.
  // A caller abort is the run's wall-clock budget expiring or the client hanging
  // up — not a provider fault. Failing over would re-issue an already-dead
  // request to every remaining credential and then report a provider outage for
  // what was actually a timeout.
  if (error instanceof APIUserAbortError) return false;

  // `APIConnectionError` also lands here — it extends `APIError` carrying no
  // status — which is the behaviour we want: a provider we cannot reach is one
  // to fail over from. 429 is named explicitly because an unwrapped rate limit
  // (which is what the embedding client raises) must move to the next key.
  if (error instanceof APIError) {
    if (error.status === undefined || error.status >= 500) return true;
    // 429 quota, 401/403 permission — all three are facts about this credential
    // rather than about the request, so the next credential may well survive them.
    return error.status === 429 || error.status === 401 || error.status === 403;
  }

  return error instanceof APIConnectionError;
}

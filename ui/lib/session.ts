/**
 * Where a conversation lives between page loads.
 *
 * **`sessionStorage`, deliberately** (PLAN.md §11.8). It is per-tab and cleared
 * when the tab closes, which is exactly the lifetime "short-term memory (within
 * session)" describes: a visitor who refreshes has not changed the subject, but
 * two tabs asking unrelated questions must not share a conversation.
 * `localStorage` would give a returning visitor a stale conversation the server
 * may well have pruned; React state alone — where this started — silently ended
 * the conversation on every refresh.
 *
 * Every accessor is guarded. `sessionStorage` throws outright, rather than
 * returning null, when a browser is set to block site data — and a thrown
 * exception here would take down the whole page for a convenience.
 */
const STORAGE_KEY = 'throughline.session';

export interface StoredSession {
  sessionId: string;
  /**
   * How many questions this tab has asked in the session.
   *
   * Counted locally rather than read off the wire: the API caps the turns it
   * keeps, so deriving this from `memory_read` would stop counting at the cap
   * and quietly under-report a long conversation.
   */
  turn: number;
}

export function readStoredSession(): StoredSession | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const { sessionId, turn } = parsed as Partial<StoredSession>;
    // Validated rather than cast: this string is sent to the API as a session
    // key, and anything could be sitting under that key on this origin.
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;

    return { sessionId, turn: typeof turn === 'number' && turn > 0 ? turn : 1 };
  } catch {
    return null;
  }
}

export function storeSession(session: StoredSession): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Continuity within this page load still works — it is held in React state
    // too. Only surviving a refresh is lost, which is not worth an error.
  }
}

export function clearStoredSession(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // See above.
  }
}

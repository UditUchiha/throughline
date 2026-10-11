/**
 * The colour theme, as an external store over `<html data-theme>`.
 *
 * The attribute is the single source of truth because the pre-paint script in
 * app/layout.tsx sets it before React exists — React state seeded from anywhere
 * else would render the wrong icon until an effect corrected it. Reading it via
 * `useSyncExternalStore` lets the server render the default and the client adopt
 * the real value without a hydration mismatch.
 *
 * `localStorage` rather than `sessionStorage` (compare lib/session.ts): a theme
 * is a preference that should outlive the tab, a conversation is not.
 */
export const THEME_STORAGE_KEY = 'throughline.theme';

export type Theme = 'dark' | 'light';

/** Dark is the default: it is the theme with no attribute at all. */
export const DEFAULT_THEME: Theme = 'dark';

export function readTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The theme still applies for this page load; only remembering it is lost.
  }
}

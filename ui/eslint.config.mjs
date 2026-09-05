import next from 'eslint-config-next';
import coreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/**
 * The UI's own lint config.
 *
 * Separate from the API's `eslint.config.mjs` — which ignores `ui/**` — because
 * this package has its own TypeScript program and its own React/JSX rules.
 * Linting it from the repo root would parse every file here against the API's
 * config and fail on all of them.
 *
 * `next lint` was removed in Next 16, so `pnpm lint` runs ESLint directly. Each
 * of these imports is a flat-config array, not a function.
 */
const config = [
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'] },
  ...next,
  ...coreWebVitals,
  ...nextTypescript,
];

export default config;

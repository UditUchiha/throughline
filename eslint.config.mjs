// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `dist/` is emitted JavaScript, and `coverage/` is a report. The `pnpm lint`
    // glob happens to dodge both; a CI job running bare `eslint .` does not, and
    // would drown in parse errors from compiled output.
    ignores: [
      'eslint.config.mjs',
      'dist/**',
      'coverage/**',
      'node_modules/**',
      // Local agent-tooling scratch space, not project source.
      '.remember/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The repository *ports* are async on purpose: they are the seam that lets a
    // network-backed adapter (genuinely async) implement them without touching a
    // single caller. better-sqlite3 is synchronous, so these adapters satisfy an
    // async interface with no `await` in the body. That is the abstraction working,
    // not an oversight — and adding a pointless `await` to each would be worse.
    files: ['src/repositories/sqlite/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
  {
    // The hook scripts are plain Node ESM, deliberately outside the TypeScript
    // program, so type-aware rules have no type information for them and every
    // file errors as "not found by the project service". Lint them syntactically
    // instead of pretending they are part of the build.
    //
    // This block must stay LAST: flat config applies later entries over earlier
    // ones, so any block that re-enables a typed rule after this would undo it.
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
);

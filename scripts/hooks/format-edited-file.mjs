/**
 * PostToolUse hook — runs Prettier over TypeScript files as they are edited.
 *
 * Scoped deliberately to *.ts under the code directories. Prettier must never touch
 * corpus/generated/**: reflowing that markdown would rewrite the exact text the index and
 * the fact verifier read, silently changing what the eval suite measures. The corpus is
 * data, not source.
 *
 * Prettier is invoked through its own entrypoint rather than the .bin shim so there is no
 * shell involved and no cmd/sh difference between Windows dev and Linux CI.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot, readHookInput, editedPath } from './_hook-io.mjs';

const FORMATTABLE = /^(src|test|scripts|evals)\/.*\.ts$/;
const PRETTIER = resolve(repoRoot, 'node_modules/prettier/bin/prettier.cjs');

const input = await readHookInput();
const path = editedPath(input);

if (!path || !FORMATTABLE.test(path) || !existsSync(PRETTIER)) {
  process.exit(0);
}

// Formatting is a convenience, never a gate: a Prettier failure (syntax error mid-edit, for
// instance) should not block the edit that Claude is in the middle of making.
spawnSync(process.execPath, [PRETTIER, '--write', path], {
  cwd: repoRoot,
  encoding: 'utf-8',
  timeout: 30_000,
});

process.exit(0);

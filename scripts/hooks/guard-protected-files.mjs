/**
 * PreToolUse hook — refuses edits to files that must not be changed by an agent.
 *
 *   .env            holds GEMINI_API_KEY and local Ollama settings. It is gitignored and
 *                   machine-specific; .env.example is the file that documents new variables.
 *   pnpm-lock.yaml  the Docker build installs with --frozen-lockfile (PLAN.md §9), so a
 *                   hand-edited lockfile breaks the image rather than the local dev loop —
 *                   the failure shows up far from its cause. Change it via pnpm.
 *   database/*.db   the sqlite-vec index. It is a build artifact of the indexer; editing it
 *                   as a file corrupts it. Delete and reindex instead.
 *
 * Denying here (rather than in permissions.deny) lets each refusal carry the reason and the
 * correct alternative, which is what actually redirects the work.
 */

import { readHookInput, editedPath } from './_hook-io.mjs';

const RULES = [
  {
    match: (p) => p === '.env' || (p.startsWith('.env') && !p.endsWith('.example')),
    reason:
      '.env is machine-local and holds secrets. To introduce a new setting, add it to ' +
      '.env.example and to the Zod schema in src/config/env.schema.ts, then tell the user ' +
      'to set the value themselves.',
  },
  {
    match: (p) => p === 'pnpm-lock.yaml',
    reason:
      'pnpm-lock.yaml is generated. The Docker build installs with --frozen-lockfile, so a ' +
      'hand-edited lockfile fails the image build. Change dependencies with `pnpm add` / ' +
      '`pnpm remove` and let pnpm rewrite it.',
  },
  {
    match: (p) => /^database\/.*\.db(-wal|-shm|-journal)?$/.test(p),
    reason:
      'This is the sqlite-vec index, a build artifact of the indexing service. To rebuild ' +
      'it, delete database/app.db* and run a reindex — do not edit the file.',
  },
];

const input = await readHookInput();
const path = editedPath(input);
const rule = path && RULES.find((r) => r.match(path));

if (rule) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Blocked edit to ${path}. ${rule.reason}`,
      },
    }),
  );
}

process.exit(0);

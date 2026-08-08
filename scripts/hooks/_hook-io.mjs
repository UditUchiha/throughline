/**
 * Shared plumbing for the Claude Code hooks in this directory.
 *
 * A hook is a plain process: Claude Code writes a JSON payload to stdin, the process
 * decides what to do, and its exit code tells Claude Code what happened —
 *   0  = fine, carry on (stdout is not shown to the model)
 *   2  = blocking error; stderr is fed back to the model as feedback
 *   1  = the hook itself broke; surfaced to the user, does not block the tool call
 *
 * These scripts are plain .mjs rather than TypeScript on purpose: they run on every
 * matching tool call, so paying ts-node's startup cost each time would be felt. They also
 * have to work in a fresh clone before `pnpm install` has run, so they use nothing but
 * the Node standard library.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, sep } from 'node:path';

/** Repo root, derived from this file's own location so the caller's cwd never matters. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Reads the hook payload from stdin. Returns `{}` if stdin is empty or not JSON. */
export async function readHookInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * The file a tool call touched, as a repo-relative POSIX path ('corpus/questions.yaml'),
 * or null when the call has no file or points outside the repo.
 *
 * Both shapes are checked because PreToolUse only has the request (`tool_input`) while
 * PostToolUse may report the resolved path on the response.
 */
export function editedPath(input) {
  const raw = input?.tool_input?.file_path ?? input?.tool_response?.filePath;
  if (typeof raw !== 'string' || raw.length === 0) return null;

  const rel = relative(repoRoot, resolve(repoRoot, raw));
  if (rel.startsWith('..')) return null; // outside the repo — not ours to police
  return rel.split(sep).join('/');
}

/**
 * PostToolUse hook — re-verifies the corpus answer key after anything under corpus/ is edited.
 *
 * Why this exists: corpus/ledger/*.yaml is the ground truth the whole eval suite is scored
 * against (PLAN.md §6). A generated document that silently drops its assigned fact, or a
 * ledger edit that leaves a fact unexpressed, corrupts recall@k and answer-correctness
 * without any test failing — the numbers just quietly stop meaning anything. The generator
 * already ships the check (`--verify-only`, no model calls, ~6s); this hook makes it
 * automatic instead of remembered.
 *
 * Note the exit-code handling below: corpus-generate.ts *reports* failed verification but
 * still exits 0, so the verdict is read from the JSON report rather than the exit code.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot, readHookInput, editedPath } from './_hook-io.mjs';

const WATCHED = [
  'corpus/ledger/', // the answer key itself
  'corpus/questions.yaml', // questions derived from fact ids
  'corpus/generated/', // hand-edited prose must still express its facts (PLAN.md §12.2)
];

const REPORT = resolve(repoRoot, 'corpus/.generation-report.json');

const input = await readHookInput();
const path = editedPath(input);

if (!path || !WATCHED.some((w) => path === w || path.startsWith(w))) {
  process.exit(0);
}

const run = spawnSync(
  process.execPath,
  [
    '--env-file-if-exists=.env',
    '-r',
    'ts-node/register',
    'scripts/corpus-generate.ts',
    '--verify-only',
  ],
  { cwd: repoRoot, encoding: 'utf-8', timeout: 120_000 },
);

// The verifier being unrunnable (no node_modules yet, ts-node missing) is a tooling gap,
// not a corpus defect. Say so and get out of the way rather than blocking an edit.
if (run.error || run.status === null) {
  console.log(
    JSON.stringify({
      systemMessage: `Corpus verification could not run (${run.error?.message ?? 'timed out'}). Run \`pnpm corpus:generate --verify-only\` manually before committing.`,
    }),
  );
  process.exit(0);
}

// Exit 1 from the script means ledger validation failed outright — a dangling fact id, an
// expressedIn pointing at a document that does not exist. That is always a real error.
if (run.status !== 0) {
  console.error(
    `Corpus ledger validation failed after editing ${path}:\n\n${run.stdout ?? ''}${run.stderr ?? ''}`,
  );
  process.exit(2);
}

if (!existsSync(REPORT)) process.exit(0);

const report = JSON.parse(readFileSync(REPORT, 'utf-8'));
if (!report.needingReview) process.exit(0);

const failures = report.entries
  .filter((e) => e.needsReview)
  .map((e) => {
    const missing = e.verification.filter((v) => !v.found).map((v) => v.token);
    return `  - ${e.docId} (${e.path}) is missing: ${missing.join(', ')}`;
  })
  .join('\n');

console.error(
  `Corpus verification failed after editing ${path} — ${report.needingReview} document(s) no ` +
    `longer express a fact assigned to them:\n\n${failures}\n\n` +
    `Each listed token is a literal string (an ISO date, an amount, a name) that the ledger ` +
    `says must appear in that document's retrievable text and does not.\n\n` +
    `Before assuming the document is at fault, check whether it could plausibly express the ` +
    `fact at all — a message cannot state something that had not happened when it was written. ` +
    `If it cannot, the fact needs splitting or reassigning in the ledger, not a regenerated ` +
    `document. See the fact.security-finding-2 precedent in PLAN.md's status section.`,
);
process.exit(2);

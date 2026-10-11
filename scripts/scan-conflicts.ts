/**
 * Audits the indexed corpus for claims that have stopped being true.
 *
 * The inversion of everything else here: the agent answers questions *from* the
 * corpus, this asks what the corpus is wrong about. Nobody thinks to ask whether
 * the pricing note is still current — they read it and act on it, and a
 * retrieval system quoting it with a resolving citation makes that worse, not
 * better, because the citation reads as verification.
 *
 * **`--measure` is the part that makes this more than a demo.** The ledger
 * records two `supersedes` chains, authored before any of this existed, so the
 * scanner can be scored rather than admired. The honest limits of that number
 * are printed with it: two positives measure recall as a smoke test, and the
 * real question — how many false conflicts a scan raises over 172 documents —
 * is answered by the count of findings a human then has to dismiss.
 *
 * The ledger is the answer key and the scanner never reads it. Candidates come
 * from the vector index alone, exactly as they would on a vault with no ledger
 * at all; `--measure` loads it afterwards, to grade.
 *
 * Usage:
 *   pnpm scan:conflicts                   # full corpus, one model call per document
 *   pnpm scan:conflicts --limit=10        # try it without paying for all of it
 *   pnpm scan:conflicts --neighbours=5    # widen the comparison set
 *   pnpm scan:conflicts --concurrency=1   # one at a time, to stop tripping rate limits
 *   pnpm scan:conflicts --docs=pricing-v1 --measure   # check one known case for one call
 *   pnpm scan:conflicts --measure         # grade against the ledger's known chains
 *   pnpm scan:conflicts --json            # machine-readable, for diffing two scans
 */

import { NestFactory } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import { ConflictsModule } from '../src/conflicts/conflicts.module';
import { ConflictScanner } from '../src/conflicts/conflict-scanner.service';
import type { Conflict, ConflictReport } from '../src/conflicts/conflict.types';

const LEDGER_PATH = 'corpus/ledger/facts.yaml';

/** Only the three fields the grader needs; the ledger carries much more. */
const ledgerSchema = z.object({
  facts: z.array(
    z.object({
      id: z.string(),
      expressedIn: z.array(z.string()).default([]),
      supersedes: z.string().nullable().default(null),
    }),
  ),
});

interface KnownChain {
  outdatedDocId: string;
  currentDocId: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limit = numberFlag(args, '--limit');
  const neighbours = numberFlag(args, '--neighbours');
  const concurrency = numberFlag(args, '--concurrency');
  const docIds = listFlag(args, '--docs');
  const measure = args.includes('--measure');
  const asJson = args.includes('--json');

  const app = await NestFactory.createApplicationContext(ConflictsModule, {
    logger: asJson ? ['error'] : ['log', 'warn', 'error'],
  });

  try {
    const scanner = app.get(ConflictScanner);
    const started = Date.now();
    const report = await scanner.scan({ limit, neighbours, concurrency, docIds });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    if (asJson) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      render(report, seconds);
    }

    if (measure) grade(report, loadKnownChains());

    // A scan that could not judge part of the corpus has not audited it. Exiting
    // 0 would let a scheduled run report "no conflicts" after a quota wall ate
    // half the documents — the failure `eval:compare` already refuses to gate
    // on, in a place where nobody would be looking for it.
    if (report.failures > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

function render(report: ConflictReport, seconds: string): void {
  const { conflicts } = report;
  const out = process.stdout;

  // "No conflicts" and "nothing was examined" produce the same empty list, and
  // the difference is the whole value of the report. The first full scan died
  // on a quota wall after judging nothing and this header said "0 finding(s)"
  // over "Nothing in the corpus contradicts itself" — a clean bill of health
  // for an audit that never ran. Same bug the eval suite records for
  // `citationValidity` rising as the agent cites less, and for the walled
  // baseline that printed a winning comparison while measuring nothing.
  const partial = report.failures > 0;
  const examined = report.documentsJudged > 0;

  out.write(`\n${'='.repeat(72)}\n`);
  out.write(
    examined
      ? `CONFLICT SCAN — ${conflicts.length} finding(s)${partial ? ' (PARTIAL)' : ''}\n`
      : 'CONFLICT SCAN — NOT RUN\n',
  );
  out.write(`${'='.repeat(72)}\n\n`);

  if (!examined) {
    out.write(
      `No document could be judged, so this is not a result.\n` +
        `${report.failures} of ${report.documentsScanned} failed — see the warnings above.\n\n`,
    );
  } else if (conflicts.length === 0) {
    out.write(
      partial
        ? 'No conflicts among the documents that were judged. Others were not examined.\n\n'
        : 'Nothing in the corpus contradicts itself.\n\n',
    );
  }

  conflicts.forEach((conflict, i) => {
    const label = conflict.kind === 'superseded' ? 'SUPERSEDED' : 'UNRESOLVED';
    out.write(`[${i + 1}] ${conflict.topic.toUpperCase()}  ·  ${label}\n\n`);
    out.write(`    ${conflict.outdated.docId}  (${conflict.outdated.source ?? 'unknown'})\n`);
    out.write(`      "${truncate(conflict.outdated.claim)}"\n\n`);
    out.write(`    ${conflict.kind === 'superseded' ? 'SUPERSEDED BY' : 'CONTRADICTED BY'}\n\n`);
    out.write(`    ${conflict.current.docId}  (${conflict.current.source ?? 'unknown'})\n`);
    out.write(`      "${truncate(conflict.current.claim)}"\n\n`);
    out.write(`    ${conflict.reasoning}\n\n`);
  });

  out.write(`${'-'.repeat(72)}\n`);
  out.write(
    `${report.documentsScanned} document(s) scanned · ` +
      `${report.documentsJudged} judged · ${report.failures} failed · ${seconds}s\n`,
  );
  if (report.failures > 0) {
    out.write(`\n⚠  ${report.failures} document(s) could not be judged. This audit is partial.\n`);
  }
  out.write('\n');
}

/**
 * Scores the scan against the chains the ledger already knew about.
 *
 * Recall over two positives is a smoke test, not a rate, and is printed as a
 * fraction rather than a percentage so it cannot be quoted as one. The number
 * that actually decides whether this is usable is the other column: every
 * finding outside the answer key is something a person has to read and dismiss,
 * and a detector that raises fifty of them over 172 documents is noise however
 * well it does on the two.
 */
function grade(report: ConflictReport, known: KnownChain[]): void {
  const out = process.stdout;
  const found = (chain: KnownChain): Conflict | undefined =>
    report.conflicts.find(
      (c) =>
        (c.outdated.docId === chain.outdatedDocId && c.current.docId === chain.currentDocId) ||
        (c.outdated.docId === chain.currentDocId && c.current.docId === chain.outdatedDocId),
    );

  out.write(`${'='.repeat(72)}\nMEASUREMENT — against ${LEDGER_PATH}\n${'='.repeat(72)}\n\n`);

  // A chain is only "missed" if something looked for it. Scoring 0/2 after a
  // quota wall records an outage as a detection failure, which is precisely
  // what `eval:compare` refuses to gate on.
  if (report.documentsJudged === 0) {
    out.write(
      `  Nothing was judged, so nothing can be scored. ${report.failures} document(s)\n` +
        `  failed — a chain cannot be counted as missed by a scan that never ran.\n\n`,
    );
    return;
  }

  let detected = 0;
  let correctlyOrdered = 0;

  for (const chain of known) {
    const hit = found(chain);
    if (hit) detected++;
    const ordered = hit?.outdated.docId === chain.outdatedDocId;
    if (ordered) correctlyOrdered++;

    out.write(`  ${hit ? '✓' : '✗'} ${chain.outdatedDocId}\n`);
    out.write(`      superseded by ${chain.currentDocId}\n`);
    if (hit) {
      // Detecting that two documents disagree is half the job; saying which one
      // to stop trusting is the half a reader acts on. A finding with the order
      // backwards is worse than no finding at all.
      out.write(`      detected as ${hit.kind}, direction ${ordered ? 'correct' : '⚠ REVERSED'}\n`);
    }
    out.write('\n');
  }

  const unknown = report.conflicts.length - detected;
  if (report.failures > 0) {
    out.write(
      `  ⚠  ${report.failures} document(s) were not judged. A ✗ below may be an\n` +
        `     outage rather than a miss, and the counts are floors, not rates.\n\n`,
    );
  }
  out.write(`  known chains detected   ${detected}/${known.length}\n`);
  out.write(`  direction correct       ${correctlyOrdered}/${known.length}\n`);
  out.write(`  findings outside the key  ${unknown}\n\n`);
  out.write(
    `  ${known.length} known positives measure recall as a smoke test, not a rate.\n` +
      `  The ${unknown} finding(s) outside the key are the real signal: each is either a\n` +
      `  genuine conflict the ledger never recorded, or noise a reader must dismiss.\n` +
      `  They need human review — this harness cannot tell the two apart.\n\n`,
  );
}

/** Resolves `supersedes` fact-id links into the document pairs a scan can find. */
function loadKnownChains(): KnownChain[] {
  const raw = yaml.load(readFileSync(resolve(LEDGER_PATH), 'utf8'), { schema: yaml.JSON_SCHEMA });
  const ledger = ledgerSchema.parse(raw);
  const byId = new Map(ledger.facts.map((fact) => [fact.id, fact]));

  return ledger.facts.flatMap((fact) => {
    if (!fact.supersedes) return [];
    const outdated = byId.get(fact.supersedes);
    // A `supersedes` pointing at a fact id that does not exist is a broken
    // chain, and silently scoring against nothing would hide it.
    if (!outdated) throw new Error(`${fact.id} supersedes unknown fact "${fact.supersedes}"`);
    if (!outdated.expressedIn[0] || !fact.expressedIn[0]) return [];
    return [{ outdatedDocId: outdated.expressedIn[0], currentDocId: fact.expressedIn[0] }];
  });
}

function numberFlag(args: string[], name: string): number | undefined {
  const match = args.find((a) => a.startsWith(`${name}=`));
  if (!match) return undefined;
  const value = Number(match.slice(name.length + 1));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${match.slice(name.length + 1)}"`);
  }
  return value;
}

/** Comma-separated substrings, for narrowing a scan to specific documents. */
function listFlag(args: string[], name: string): string[] | undefined {
  const match = args.find((a) => a.startsWith(`${name}=`));
  if (!match) return undefined;
  const values = match
    .slice(name.length + 1)
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  if (values.length === 0) throw new Error(`${name} needs at least one document id fragment`);
  return values;
}

function truncate(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

main().catch((error: unknown) => {
  process.stderr.write(`\n${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});

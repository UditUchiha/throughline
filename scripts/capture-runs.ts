/**
 * Captures live agent runs to `fixtures/runs/*.json` for replay.
 *
 * Why this exists: one agent run costs roughly four model calls, against a free
 * tier measured in tens of requests per minute. Building a UI against live runs
 * means every save and every refresh spends quota, and the quota runs out at the
 * least convenient moment. Capturing a handful of good runs once turns UI work,
 * demos, and (later) UI tests into a free, deterministic, offline exercise.
 *
 * The fixtures are the real event stream, byte for byte, so replaying one
 * exercises the consumer's production code path rather than a parallel "demo
 * mode" that quietly drifts from the thing it is meant to demonstrate.
 *
 * Usage — the API must already be running (`pnpm start:dev`):
 *   pnpm capture:runs                 # capture anything not already on disk
 *   pnpm capture:runs --force         # re-capture everything
 *   pnpm capture:runs --only=<slug>   # capture one
 *   pnpm capture:runs --list          # show the catalogue, spend nothing
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface CaptureTarget {
  slug: string;
  question: string;
  /** What this fixture is here to prove, shown in the UI's example list. */
  label: string;
}

/**
 * Chosen to cover every distinct thing the UI has to render, not to be a
 * representative sample of the corpus. Each was verified to behave this way
 * against the real index — notably the second-hop one, which only about three
 * in thirty multi-hop questions actually trigger.
 */
const TARGETS: CaptureTarget[] = [
  {
    slug: 'simple-tariq-start',
    question: 'When did Tariq Hassan start at Lumen Labs?',
    label: 'Simple — triage skips planning entirely',
  },
  {
    // The landing page's hero (ui/components/HeroQuestion.tsx), which is why this
    // one is verified rather than merely scored: both halves come from the first
    // parallel fan-out, so it does not depend on the second hop that fires on
    // roughly three of thirty multi-hop questions. See that file for the two
    // candidates rejected for answering only half the question live.
    slug: 'multihop-helios-owner-cause',
    question:
      'Who owns the workstream that caused the Helios delay, and what exactly went wrong technically?',
    label: 'Multi-hop — one answer from chat and notes together',
  },
  // 'Why did the Helios launch slip, and who approved the new date?' was here and
  // is deliberately gone. The corpus holds two distinct Helios delays — the billing
  // migration failing load testing at 4x volume (the slip), and a separate one-day
  // TLS certificate slip at ship time — and retrieval lands on the second. The eval
  // suite scores that question `partial` for exactly this reason, with the judge
  // naming the contradiction, and a fresh capture reproduced it. Do not re-add it as
  // a demo until retrieval can tell the two apart; a one-click example that answers
  // confidently and wrongly is worse than one fewer example.
  {
    slug: 'second-hop-board-outcomes',
    question: 'What did the board approve and what were the outcomes?',
    label: 'Second hop — reflection finds a gap and retrieves again',
  },
  {
    slug: 'abstention-unanswerable',
    question: 'What is the CEO of Lumen Labs home address and personal phone number?',
    label: 'Abstention — the answer is not in the sources',
  },
];

interface EmittedEvent {
  type: string;
  seq: number;
  ts: string;
  [key: string]: unknown;
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const listOnly = args.includes('--list');
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);

const port = process.env.PORT ?? '5000';
const baseUrl = `http://localhost:${port}`;
const outDir = process.env.DEMO_RUNS_PATH ?? './fixtures/runs';

async function captureOne(target: CaptureTarget): Promise<EmittedEvent[]> {
  const response = await fetch(`${baseUrl}/agent/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: target.question }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${baseUrl}/agent/ask`);
  }

  // The stream is short and we want the whole thing, so buffering is simpler than
  // incremental parsing and loses nothing.
  const body = await response.text();
  return body
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as EmittedEvent);
}

/** Events carry an index signature, so field reads are `unknown` until narrowed. */
function scalar(value: unknown, fallback = '?'): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

function describe(events: EmittedEvent[]): string {
  const finished = events.find((e) => e.type === 'run_finished');
  const failed = events.find((e) => e.type === 'run_failed');
  if (failed) return `FAILED — ${scalar(failed.error, 'unknown error').slice(0, 90)}`;

  const triage = events.find((e) => e.type === 'triage_done');
  const tools = events.filter((e) => e.type === 'tool_started').length;
  const secondHop = events.some((e) => e.type === 'reflect_done' && e.gapFound === true);
  const citations = Array.isArray(finished?.citations) ? finished.citations.length : 0;

  return [
    scalar(triage?.complexity).padEnd(7),
    `${tools} tool call(s)`,
    `${citations} citation(s)`,
    secondHop ? 'SECOND HOP' : '',
    `${scalar(finished?.latencyMs)}ms`,
  ]
    .filter(Boolean)
    .join('  ');
}

async function main(): Promise<void> {
  const selected = only ? TARGETS.filter((t) => t.slug === only) : TARGETS;

  if (only && selected.length === 0) {
    console.error(`No target "${only}". Known: ${TARGETS.map((t) => t.slug).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  if (listOnly) {
    for (const target of TARGETS) {
      const path = join(outDir, `${target.slug}.json`);
      console.log(`${existsSync(path) ? '[captured]' : '[  missing]'} ${target.slug}`);
      console.log(`             ${target.label}`);
      console.log(`             "${target.question}"`);
    }
    return;
  }

  mkdirSync(outDir, { recursive: true });

  let captured = 0;
  let skipped = 0;
  let failed = 0;

  for (const target of selected) {
    const path = join(outDir, `${target.slug}.json`);

    // Skipping by default is the point: re-capturing an existing fixture spends
    // model calls to replace something that already works.
    if (!force && existsSync(path)) {
      const existing: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const events = (existing as { events?: EmittedEvent[] }).events ?? [];
      console.log(`skip     ${target.slug.padEnd(28)} already captured (${events.length} events)`);
      skipped++;
      continue;
    }

    process.stdout.write(`capture  ${target.slug.padEnd(28)} `);
    try {
      const events = await captureOne(target);
      const runFailed = events.some((e) => e.type === 'run_failed');

      writeFileSync(
        path,
        `${JSON.stringify(
          {
            question: target.question,
            label: target.label,
            capturedAt: new Date().toISOString(),
            events,
          },
          null,
          2,
        )}\n`,
      );

      console.log(describe(events));
      if (runFailed) {
        // Kept rather than discarded: a real failed run is the only honest
        // fixture for the UI's error state, and it is hard to produce on demand.
        console.log(
          `         ^ saved anyway — useful as an error-state fixture, but re-run ` +
            `with --force once quota recovers if you wanted a successful one`,
        );
        failed++;
      } else {
        captured++;
      }
    } catch (error) {
      console.log(`ERROR — ${error instanceof Error ? error.message : String(error)}`);
      failed++;
    }
  }

  console.log(`\n${captured} captured, ${skipped} skipped, ${failed} failed → ${outDir}`);
  if (captured === 0 && skipped === 0) {
    console.log('Is the API running? Start it with `pnpm start:dev`.');
    process.exitCode = 1;
  }
}

void main();

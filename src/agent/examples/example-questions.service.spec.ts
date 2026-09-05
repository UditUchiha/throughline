import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfigService } from '../../config/app-config.service';
import { ExampleQuestionsService } from './example-questions.service';

const LEDGER = `questions:
  - id: q.tariq-start-date
    question: "When did Tariq Hassan start at Lumen Labs?"
    category: single-hop
    requiredFacts: [fact.tariq-start-date]
    requiredSources: [chat]
    minHops: 0
    expectedAbstention: false
    referenceAnswer: "Tariq Hassan started on 2026-01-05."

  - id: q.board-outcomes
    question: "What did the board approve and what were the outcomes?"
    category: multi-hop
    requiredFacts: [fact.board-update-arr]
    requiredSources: [notes, mail]
    minHops: 1
    expectedAbstention: false
    referenceAnswer: "Usage-based pricing."

  - id: q.ceo-salary
    question: "What is the CEO's salary?"
    category: unanswerable
    requiredFacts: []
    requiredSources: []
    minHops: 0
    expectedAbstention: true
    referenceAnswer: "Not in the sources."
`;

function makeService(contents: string | null): {
  service: ExampleQuestionsService;
  dir: string;
  path: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'throughline-questions-'));
  const path = join(dir, 'questions.yaml');
  if (contents !== null) writeFileSync(path, contents);

  const config = { corpusQuestionsPath: path } as AppConfigService;
  return { service: new ExampleQuestionsService(config), dir, path };
}

describe('ExampleQuestionsService', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it('projects the ledger to the fields the UI needs', () => {
    const { service, dir } = makeService(LEDGER);
    dirs.push(dir);

    const questions = service.list();

    expect(questions).toHaveLength(3);
    expect(questions[0]).toEqual({
      id: 'q.tariq-start-date',
      question: 'When did Tariq Hassan start at Lumen Labs?',
      category: 'single-hop',
      requiredSources: ['chat'],
      minHops: 0,
      expectedAbstention: false,
    });
    expect(questions[2].expectedAbstention).toBe(true);
  });

  // The whole point of the projection: `referenceAnswer` is the graded answer and
  // `requiredFacts` is the answer key. Serving either would let the corpus grade
  // itself (PLAN.md §6).
  it('never serves the answer key', () => {
    const { service, dir } = makeService(LEDGER);
    dirs.push(dir);

    for (const question of service.list()) {
      expect(question).not.toHaveProperty('referenceAnswer');
      expect(question).not.toHaveProperty('requiredFacts');
    }
    expect(JSON.stringify(service.list())).not.toContain('2026-01-05');
  });

  it('returns an empty list rather than throwing when the ledger is missing', () => {
    const { service, dir } = makeService(null);
    dirs.push(dir);

    expect(service.list()).toEqual([]);
  });

  it('returns an empty list rather than throwing when the ledger is malformed', () => {
    const { service, dir } = makeService('questions:\n  - id: 1\n    nope: true\n');
    dirs.push(dir);

    expect(service.list()).toEqual([]);
  });

  // The endpoint is the UI's whole entry point — a visitor cannot invent a question
  // this corpus answers — so one unparseable row must not take the other 55 with it.
  // A new category value is exactly the edit `/add-fact` would make.
  it('skips a row it cannot parse rather than emptying the set', () => {
    const { service, dir } = makeService(
      LEDGER +
        `
  - id: q.from-the-future
    question: "A question in a category this build has never heard of?"
    category: hypothetical
    requiredSources: [chat]
    minHops: 0
    expectedAbstention: false
`,
    );
    dirs.push(dir);

    const questions = service.list();

    expect(questions).toHaveLength(3);
    expect(questions.map((q) => q.id)).not.toContain('q.from-the-future');
  });

  it('ignores ledger fields it does not serve without dropping the row', () => {
    const { service, dir } = makeService(
      `questions:
  - id: q.with-extras
    question: "Does an unknown key break this?"
    category: single-hop
    requiredSources: [notes]
    minHops: 0
    expectedAbstention: false
    someFieldAddedLater: true
`,
    );
    dirs.push(dir);

    expect(service.list()).toHaveLength(1);
  });

  it('picks up an edit without a restart', async () => {
    const { service, dir, path } = makeService(LEDGER);
    dirs.push(dir);
    expect(service.list()).toHaveLength(3);

    // mtime has second-or-worse granularity on some filesystems; nudge it so the
    // change is observable rather than relying on the write being slow enough.
    await new Promise((resolve) => setTimeout(resolve, 10));
    writeFileSync(
      path,
      LEDGER +
        `
  - id: q.offsite-dates
    question: "When is the offsite?"
    category: single-hop
    requiredSources: [chat]
    minHops: 0
    expectedAbstention: false
`,
    );

    expect(service.list()).toHaveLength(4);
  });
});

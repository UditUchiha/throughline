'use client';

import { useMemo, useState } from 'react';
import type { DemoRun, ExampleQuestion, QuestionCategory } from '@/lib/api';
import { categoryLabel, formatMs } from '@/lib/presentation';
import { SourceBadge } from './SourceBadge';

/**
 * The one-click examples.
 *
 * PLAN.md §5/M2 calls this "not optional, and not cosmetic", and it is right: a
 * visitor has never heard of Lumen Labs and cannot invent a question its corpus
 * can answer. The labels advertise *behaviour* — "should refuse to answer" is a
 * dare, and watching the system decline is more convincing than any answer.
 */

/**
 * Order chosen so the two most interesting behaviours are the first things read.
 *
 * Not exhaustive by contract — the API owns this vocabulary. Categories not
 * listed here sort to the end rather than vanishing; dropping them would leave
 * "show all 56" rendering fewer than 56.
 */
const CATEGORY_ORDER: QuestionCategory[] = [
  'multi-hop',
  'unanswerable',
  'temporal',
  'distractor',
  'single-hop',
];

function categoryRank(category: QuestionCategory): number {
  const index = CATEGORY_ORDER.indexOf(category);
  return index === -1 ? CATEGORY_ORDER.length : index;
}

/** Every category actually present, in display order, whether or not it is known. */
function categoriesPresent(examples: ExampleQuestion[]): QuestionCategory[] {
  return [...new Set(examples.map((example) => example.category))].sort(
    (a, b) => categoryRank(a) - categoryRank(b) || a.localeCompare(b),
  );
}

export function ExampleQuestions({
  examples,
  demoRuns,
  demo,
  disabled,
  onPick,
}: {
  examples: ExampleQuestion[];
  demoRuns: DemoRun[];
  demo: boolean;
  disabled: boolean;
  onPick: (question: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);

  const spread = useMemo(() => pickSpread(examples), [examples]);

  // In replay mode only recorded questions can work at all, so offering the other
  // 52 would be offering 52 dead ends.
  if (demo) {
    return (
      <Section
        title="Recorded runs"
        note="Replayed from fixtures/runs — the same event stream, no model calls."
      >
        {demoRuns.length === 0 ? (
          <Empty>
            No runs have been captured yet. Run <Code>pnpm capture:runs</Code> against a live
            server.
          </Empty>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {demoRuns.map((run) => (
              <button
                key={run.slug}
                type="button"
                disabled={disabled}
                onClick={() => onPick(run.question)}
                className="group rounded-lg border border-white/10 bg-ink-900/50 p-3 text-left transition hover:border-white/25 hover:bg-ink-850/60 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-[0.65rem] tracking-wide text-signal/80">
                    {run.label ?? run.slug}
                  </span>
                  <span className="shrink-0 font-mono text-[0.65rem] text-ink-700">
                    {formatMs(run.durationMs)} live
                  </span>
                </div>
                <p className="mt-1.5 text-sm text-ink-300 group-hover:text-ink-100">
                  {run.question}
                </p>
              </button>
            ))}
          </div>
        )}
      </Section>
    );
  }

  const shown = showAll ? groupByCategory(examples) : [{ category: null, questions: spread }];

  return (
    <Section
      title="Try one"
      note={`${examples.length} authored questions — the same set the eval suite is scored on.`}
    >
      {examples.length === 0 ? (
        <Empty>The API returned no example questions.</Empty>
      ) : (
        <div className="space-y-4">
          {shown.map((group) => (
            <div key={group.category ?? 'spread'}>
              {group.category && (
                <h3 className="mb-2 font-mono text-[0.65rem] tracking-widest text-ink-700 uppercase">
                  {group.category} · {categoryLabel(group.category)}
                </h3>
              )}
              <div className="grid gap-2 sm:grid-cols-2">
                {group.questions.map((example) => (
                  <ExampleChip
                    key={example.id}
                    example={example}
                    disabled={disabled}
                    onPick={onPick}
                  />
                ))}
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={() => setShowAll((current) => !current)}
            className="font-mono text-[0.7rem] text-ink-500 underline decoration-dotted underline-offset-4 transition hover:text-ink-300"
          >
            {showAll ? 'show fewer' : `show all ${examples.length}`}
          </button>
        </div>
      )}
    </Section>
  );
}

function ExampleChip({
  example,
  disabled,
  onPick,
}: {
  example: ExampleQuestion;
  disabled: boolean;
  onPick: (question: string) => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onPick(example.question)}
      className="group rounded-lg border border-white/10 bg-ink-900/50 p-3 text-left transition hover:border-white/25 hover:bg-ink-850/60 disabled:cursor-not-allowed disabled:opacity-45"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[0.65rem] tracking-wide text-signal/80">
          {categoryLabel(example.category)}
        </span>
        {example.requiredSources.map((source) => (
          <SourceBadge key={source} source={source} />
        ))}
        {example.demoSlug && (
          <span
            title="A recorded run exists for this question, so it also works in replay mode."
            className="font-mono text-[0.6rem] text-ink-700"
          >
            ● recorded
          </span>
        )}
      </div>
      <p className="mt-1.5 text-sm text-ink-300 group-hover:text-ink-100">{example.question}</p>
    </button>
  );
}

/**
 * One question per category — the spread PLAN.md §5/M2 asks for.
 *
 * Within a category, a question with a recording wins: a visitor who later ticks
 * replay mode then finds the same question waiting instead of a dead end. Among
 * the rest, one that needs a second hop wins, because the reflect→execute loop is
 * the behaviour worth watching and it fires on roughly one multi-hop question in
 * ten — picking blindly usually gets a single-round run.
 */
function pickSpread(examples: ExampleQuestion[]): ExampleQuestion[] {
  const spread: ExampleQuestion[] = [];

  for (const category of categoriesPresent(examples)) {
    const inCategory = examples.filter((example) => example.category === category);
    if (inCategory.length === 0) continue;

    spread.push(
      inCategory.find((example) => example.demoSlug && example.minHops > 0) ??
        inCategory.find((example) => example.demoSlug) ??
        inCategory.find((example) => example.minHops > 0) ??
        inCategory[0],
    );
  }

  return spread;
}

function groupByCategory(examples: ExampleQuestion[]) {
  return categoriesPresent(examples).map((category) => ({
    category,
    questions: examples.filter((example) => example.category === category),
  }));
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <span>{title}</span>
        <span className="hidden text-[0.65rem] normal-case sm:inline">{note}</span>
      </div>
      <div className="p-3 sm:p-4">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-ink-500">{children}</p>;
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-ink-950/80 px-1.5 py-0.5 font-mono text-[0.75rem] text-ink-300">
      {children}
    </code>
  );
}

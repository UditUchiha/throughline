'use client';

import { useMemo, useState } from 'react';
import { ArrowRight, ChevronDown, CircleDot, Lightbulb, Timer, type LucideIcon } from 'lucide-react';
import type { DemoRun, ExampleQuestion, QuestionCategory } from '@/lib/api';
import { categoryLabel, formatMs } from '@/lib/presentation';
import { Code, Panel } from './Panel';
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
        icon={CircleDot}
        note="Replayed from fixtures/runs — the same event stream, no model calls."
      >
        {demoRuns.length === 0 ? (
          <Empty>
            No runs have been captured yet. Run <Code>pnpm capture:runs</Code> against a live
            server.
          </Empty>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {demoRuns.map((run) => (
              <QuestionCard
                key={run.slug}
                question={run.question}
                disabled={disabled}
                onPick={onPick}
                eyebrow={run.label ?? run.slug}
                footer={
                  <span className="inline-flex items-center gap-1.5 font-mono text-xs text-muted">
                    <Timer className="size-3.5" aria-hidden />
                    {formatMs(run.durationMs)} live
                  </span>
                }
              />
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
      icon={Lightbulb}
      note={`${examples.length} authored questions — the same set the eval suite is scored on.`}
    >
      {examples.length === 0 ? (
        <Empty>The API returned no example questions.</Empty>
      ) : (
        <div className="space-y-6">
          {shown.map((group) => (
            <div key={group.category ?? 'spread'}>
              {group.category && (
                <h3 className="eyebrow mb-3 flex items-center gap-2 text-faint">
                  {group.category} · {categoryLabel(group.category)}
                  <span aria-hidden className="h-px flex-1 bg-line" />
                </h3>
              )}
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {group.questions.map((example) => (
                  <QuestionCard
                    key={example.id}
                    question={example.question}
                    disabled={disabled}
                    onPick={onPick}
                    eyebrow={categoryLabel(example.category)}
                    footer={
                      <>
                        {example.requiredSources.map((source) => (
                          <SourceBadge key={source} source={source} />
                        ))}
                        {example.demoSlug && (
                          <span
                            title="A recorded run exists for this question, so it also works in replay mode."
                            className="inline-flex items-center gap-1 font-mono text-xs text-muted"
                          >
                            <CircleDot className="size-3.5" aria-hidden />
                            recorded
                          </span>
                        )}
                      </>
                    }
                  />
                ))}
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={() => setShowAll((current) => !current)}
            aria-expanded={showAll}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-surface-2/60 px-4 text-sm text-fg-2 transition-colors duration-150 hover:border-line-strong hover:text-fg"
          >
            <ChevronDown
              className={`size-4 transition-transform duration-200 ${showAll ? 'rotate-180' : ''}`}
              aria-hidden
            />
            {showAll ? 'Show fewer' : `Show all ${examples.length}`}
          </button>
        </div>
      )}
    </Section>
  );
}

function QuestionCard({
  question,
  eyebrow,
  footer,
  disabled,
  onPick,
}: {
  question: string;
  eyebrow: string;
  footer: React.ReactNode;
  disabled: boolean;
  onPick: (question: string) => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onPick(question)}
      className="group flex h-full flex-col rounded-xl border border-line bg-surface-2/50 p-4 text-left transition-[border-color,background-color,transform] duration-200 enabled:hover:-translate-y-0.5 enabled:hover:border-line-strong enabled:hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-45"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs font-medium text-signal">{eyebrow}</span>
        <ArrowRight
          className="size-4 shrink-0 text-faint transition-[transform,color] duration-200 group-enabled:group-hover:translate-x-0.5 group-enabled:group-hover:text-signal"
          aria-hidden
        />
      </span>
      <span className="mt-2 flex-1 text-sm leading-relaxed text-fg-2 group-enabled:group-hover:text-fg">
        {question}
      </span>
      <span className="mt-3 flex flex-wrap items-center gap-1.5">{footer}</span>
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
  icon,
  note,
  children,
}: {
  title: string;
  icon: LucideIcon;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <Panel title={title} icon={icon}>
      <p className="mb-4 text-sm text-muted">{note}</p>
      {children}
    </Panel>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}

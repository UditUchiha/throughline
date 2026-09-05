'use client';

import type { SubQuestion, SubQuestionStatus } from '@/lib/agent-events';
import type { Reflection, RunView } from '@/lib/run-state';
import { sourceForTool, sourceStyle } from '@/lib/presentation';
import { SourceBadge } from './SourceBadge';

/**
 * The plan, and the reflect→execute loop that extends it.
 *
 * Sub-questions are grouped by hop with the reflection verdict shown between
 * groups, because "the agent noticed a gap and went back for more" is a claim the
 * layout should make on its own — a flat list of five sub-questions hides it.
 */
export function PlanPanel({ view }: { view: RunView }) {
  const hops = groupByHop(view.subQuestions);

  // A `simple` verdict is what makes the missing plan meaningful. Keying off
  // `!view.planned` alone would announce "triage judged this simple" during the
  // seconds a *complex* run spends waiting on the planning call — a claim the
  // panel would then contradict when `plan_created` arrived.
  const skippedPlanning = view.triage?.complexity === 'simple';
  const planning = view.triage?.complexity === 'complex' && !view.planned;

  return (
    <section className="panel">
      <div className="panel-heading">
        <span>Plan</span>
        {view.triage && (
          <span className="font-normal normal-case text-ink-500">
            {view.planned
              ? `${view.subQuestions.filter((sq) => sq.hop === 0).length} sub-questions`
              : skippedPlanning
                ? 'skipped'
                : 'planning…'}
          </span>
        )}
      </div>

      <div className="space-y-3 p-3 sm:p-4">
        {!view.triage && <Waiting>waiting for triage…</Waiting>}

        {planning && <Waiting>decomposing into sub-questions…</Waiting>}

        {skippedPlanning && !view.planned && (
          // The *absence* of a plan is the interesting event on a simple question:
          // triage decided decomposition would not pay for itself, and the run is
          // measurably faster for it. Saying nothing here would waste that.
          <p className="rounded-lg border border-dashed border-white/12 bg-ink-900/40 p-3 text-sm text-ink-500">
            Triage judged this <span className="text-ink-100">simple</span> and skipped planning —
            straight to one broad retrieval. No planning model call was made.
          </p>
        )}

        {hops.map(({ hop, subQuestions }, index) => (
          <div key={hop} className="space-y-2">
            {index > 0 && <ReflectionRow reflection={view.reflections[index - 1]} hop={hop} />}
            {hops.length > 1 && (
              <p className="font-mono text-[0.65rem] tracking-widest text-ink-700 uppercase">
                hop {hop}
              </p>
            )}
            {subQuestions.map((subQuestion) => (
              <SubQuestionRow key={subQuestion.id} subQuestion={subQuestion} />
            ))}
          </div>
        ))}

        {/* The last reflection has no hop after it — it is the decision to stop. */}
        {view.reflections.length >= hops.length && view.reflections.length > 0 && (
          <ReflectionRow reflection={view.reflections[view.reflections.length - 1]} hop={null} />
        )}
      </div>
    </section>
  );
}

function SubQuestionRow({ subQuestion }: { subQuestion: SubQuestion }) {
  const style = sourceStyle(sourceForTool(subQuestion.tool));

  return (
    <div
      className={`${style.className} rounded-lg border border-white/8 bg-ink-900/50 p-2.5 pl-3 shadow-[inset_2px_0_0_0_var(--accent)]`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm leading-snug text-ink-100">{subQuestion.text}</p>
        <StatusDot status={subQuestion.status} />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[0.65rem] text-ink-700">{subQuestion.id}</span>
        <SourceBadge source={sourceForTool(subQuestion.tool)}>{subQuestion.tool}</SourceBadge>
        {subQuestion.error && (
          <span className="text-[0.7rem] text-danger">{subQuestion.error}</span>
        )}
      </div>
    </div>
  );
}

function ReflectionRow({ reflection, hop }: { reflection?: Reflection; hop: number | null }) {
  if (!reflection) return null;

  return (
    <div className="flex items-start gap-2 rounded-lg border border-white/8 bg-ink-950/40 p-2.5">
      <span
        aria-hidden
        className={`mt-0.5 font-mono text-xs ${reflection.gapFound ? 'text-warn' : 'text-signal'}`}
      >
        {reflection.gapFound ? '↻' : '✓'}
      </span>
      <p className="text-xs leading-relaxed text-ink-500">
        {reflection.gapFound ? (
          <>
            <span className="text-ink-300">Reflection found a gap</span> — issuing{' '}
            {reflection.followUps.length} follow-up{reflection.followUps.length === 1 ? '' : 's'}
            {hop !== null && <> as hop {hop}</>}.
          </>
        ) : (
          <>
            <span className="text-ink-300">Reflection found no gap</span> — the evidence answers the
            question, so no further retrieval.
          </>
        )}
      </p>
    </div>
  );
}

const STATUS_STYLES: Record<SubQuestionStatus, { className: string; label: string }> = {
  pending: { className: 'bg-ink-700', label: 'pending' },
  running: { className: 'bg-signal running-bar', label: 'running' },
  done: { className: 'bg-signal', label: 'done' },
  failed: { className: 'bg-danger', label: 'failed' },
};

function StatusDot({ status }: { status: SubQuestionStatus }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.pending;

  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-[0.6rem] text-ink-700">
      <span className={`size-1.5 rounded-full ${style.className}`} aria-hidden />
      {style.label}
    </span>
  );
}

function Waiting({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-xs text-ink-700">{children}</p>;
}

function groupByHop(subQuestions: SubQuestion[]): { hop: number; subQuestions: SubQuestion[] }[] {
  const byHop = new Map<number, SubQuestion[]>();
  for (const subQuestion of subQuestions) {
    const bucket = byHop.get(subQuestion.hop);
    if (bucket) bucket.push(subQuestion);
    else byHop.set(subQuestion.hop, [subQuestion]);
  }
  return [...byHop.entries()]
    .sort(([a], [b]) => a - b)
    .map(([hop, entries]) => ({ hop, subQuestions: entries }));
}

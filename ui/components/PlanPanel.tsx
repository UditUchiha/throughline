'use client';

import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  ListTree,
  LoaderCircle,
  RefreshCcw,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { SubQuestion, SubQuestionStatus } from '@/lib/agent-events';
import type { Reflection, RunView } from '@/lib/run-state';
import { sourceForTool, sourceStyle } from '@/lib/presentation';
import { Panel, Waiting } from './Panel';
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
  const live = view.status === 'streaming';

  // A `simple` verdict is what makes the missing plan meaningful. Keying off
  // `!view.planned` alone would announce "triage judged this simple" during the
  // seconds a *complex* run spends waiting on the planning call — a claim the
  // panel would then contradict when `plan_created` arrived.
  const skippedPlanning = view.triage?.complexity === 'simple';
  const planning = view.triage?.complexity === 'complex' && !view.planned;

  return (
    <Panel
      title="Plan"
      icon={ListTree}
      meta={
        view.triage &&
        (view.planned
          ? `${view.subQuestions.filter((sq) => sq.hop === 0).length} sub-questions`
          : skippedPlanning
            ? 'skipped'
            : 'planning…')
      }
    >
      <div className="space-y-3">
        {!view.triage && <Waiting live={live}>Waiting for triage…</Waiting>}

        {planning && <Waiting live={live}>Decomposing into sub-questions…</Waiting>}

        {skippedPlanning && !view.planned && (
          // The *absence* of a plan is the interesting event on a simple question:
          // triage decided decomposition would not pay for itself, and the run is
          // measurably faster for it. Saying nothing here would waste that.
          <div className="flex gap-2.5 rounded-xl border border-dashed border-line-strong bg-surface-2/50 p-3 text-sm leading-relaxed text-muted">
            <Zap className="mt-0.5 size-4 shrink-0 text-signal" aria-hidden />
            <p>
              Triage judged this <span className="font-medium text-fg">simple</span> and skipped
              planning — straight to one broad retrieval. No planning model call was made.
            </p>
          </div>
        )}

        {hops.map(({ hop, subQuestions }, index) => (
          <div key={hop} className="space-y-2">
            {index > 0 && <ReflectionRow reflection={view.reflections[index - 1]} hop={hop} />}
            {hops.length > 1 && (
              <p className="eyebrow flex items-center gap-2 pt-1 text-faint">
                hop {hop}
                <span aria-hidden className="h-px flex-1 bg-line" />
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
    </Panel>
  );
}

function SubQuestionRow({ subQuestion }: { subQuestion: SubQuestion }) {
  const source = sourceForTool(subQuestion.tool);
  const style = sourceStyle(source);

  return (
    <div
      className={`${style.className} animate-enter rounded-xl border border-line bg-surface-2/60 p-3 pl-3.5 shadow-[inset_3px_0_0_0_var(--accent)]`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm leading-snug text-fg">{subQuestion.text}</p>
        <StatusChip status={subQuestion.status} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-faint">{subQuestion.id}</span>
        <SourceBadge source={source}>{subQuestion.tool}</SourceBadge>
        {subQuestion.error && <span className="text-xs text-danger">{subQuestion.error}</span>}
      </div>
    </div>
  );
}

function ReflectionRow({ reflection, hop }: { reflection?: Reflection; hop: number | null }) {
  if (!reflection) return null;

  const Icon = reflection.gapFound ? RefreshCcw : CircleCheck;

  return (
    <div className="animate-enter flex items-start gap-2.5 rounded-xl border border-dashed border-line-strong bg-surface-2/40 p-3">
      <Icon
        aria-hidden
        className={`mt-0.5 size-4 shrink-0 ${reflection.gapFound ? 'text-warn' : 'text-signal'}`}
      />
      <p className="text-sm leading-relaxed text-muted">
        {reflection.gapFound ? (
          <>
            <span className="font-medium text-fg-2">Reflection found a gap</span> — issuing{' '}
            {reflection.followUps.length} follow-up{reflection.followUps.length === 1 ? '' : 's'}
            {hop !== null && <> as hop {hop}</>}.
          </>
        ) : (
          <>
            <span className="font-medium text-fg-2">Reflection found no gap</span> — the evidence
            answers the question, so no further retrieval.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * An icon *and* a word for each status. The colour alone would leave "failed"
 * and "done" distinguishable only by hue.
 */
const STATUS_STYLES: Record<
  SubQuestionStatus,
  { icon: LucideIcon; className: string; label: string }
> = {
  pending: { icon: CircleDashed, className: 'text-faint', label: 'pending' },
  running: { icon: LoaderCircle, className: 'text-signal animate-spin', label: 'running' },
  done: { icon: CircleCheck, className: 'text-signal', label: 'done' },
  failed: { icon: CircleAlert, className: 'text-danger', label: 'failed' },
};

function StatusChip({ status }: { status: SubQuestionStatus }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.pending;
  const Icon = style.icon;

  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs text-muted">
      <Icon className={`size-3.5 ${style.className}`} aria-hidden />
      {style.label}
    </span>
  );
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

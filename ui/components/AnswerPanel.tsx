'use client';

import type { Citation } from '@/lib/agent-events';
import type { RunView } from '@/lib/run-state';

/**
 * The answer, with `[n]` markers turned into chips that jump to their evidence.
 *
 * Markers become clickable only once `run_finished` carries the citation table.
 * During streaming they stay literal text — a chip that resolves to nothing is
 * worse than a bracketed number, and the mapping genuinely does not exist yet.
 */
export function AnswerPanel({
  view,
  onCite,
  activeEvidenceId,
}: {
  view: RunView;
  onCite: (evidenceId: string) => void;
  activeEvidenceId: string | null;
}) {
  const streaming = view.status === 'streaming';
  const text = view.answer?.text ?? view.streamedText;
  const abstained = view.answer?.abstained ?? false;

  return (
    <section className="panel">
      <div className="panel-heading">
        <span>Answer</span>
        <span className="font-normal normal-case text-ink-500">
          {view.status === 'finished' && (
            <>
              {/* Zero citations is a legitimate outcome when the agent declines —
                  it is not an error state and must not be dressed as one. */}
              {abstained
                ? 'abstained'
                : `${view.citations.length} citation${view.citations.length === 1 ? '' : 's'}`}
            </>
          )}
        </span>
      </div>

      <div className="p-4 sm:p-5">
        {!text && streaming && (
          <p className="font-mono text-xs text-ink-700">
            synthesising
            <Ellipsis />
          </p>
        )}
        {!text && !streaming && (
          <p className="text-sm text-ink-700">Ask a question to see an answer here.</p>
        )}

        {text && (
          <div
            className={`text-[0.95rem] leading-[1.75] whitespace-pre-wrap ${
              abstained ? 'text-ink-500 italic' : 'text-ink-100'
            }`}
          >
            <CitedText
              text={text}
              citations={view.citations}
              onCite={onCite}
              activeEvidenceId={activeEvidenceId}
            />
            {streaming && <Caret />}
          </div>
        )}

        {abstained && (
          <p className="mt-3 border-t border-white/8 pt-3 text-xs text-ink-500">
            The corpus contains no answer to this, and abstaining is the correct behaviour — it is a
            scored outcome, not a failure.
          </p>
        )}
      </div>
    </section>
  );
}

const MARKER_PATTERN = /(\[\d+\])/g;

function CitedText({
  text,
  citations,
  onCite,
  activeEvidenceId,
}: {
  text: string;
  citations: Citation[];
  onCite: (evidenceId: string) => void;
  activeEvidenceId: string | null;
}) {
  const byMarker = new Map(citations.map((citation) => [citation.marker, citation.evidenceId]));

  return (
    <>
      {text.split(MARKER_PATTERN).map((part, index) => {
        const match = /^\[(\d+)\]$/.exec(part);
        const evidenceId = match ? byMarker.get(Number(match[1])) : undefined;

        if (!match || !evidenceId) return <span key={index}>{part}</span>;

        return (
          <button
            key={index}
            type="button"
            onClick={() => onCite(evidenceId)}
            title={`Jump to ${evidenceId}`}
            className={`mx-0.5 inline-flex min-w-6 translate-y-[-1px] items-center justify-center rounded border px-1 align-middle font-mono text-[0.7rem] leading-5 transition ${
              activeEvidenceId === evidenceId
                ? 'border-signal bg-signal text-ink-950'
                : 'border-signal/40 bg-signal/12 text-signal hover:bg-signal/25'
            }`}
          >
            {match[1]}
          </button>
        );
      })}
    </>
  );
}

function Caret() {
  return (
    <span
      aria-hidden
      className="running-bar ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 bg-signal"
    />
  );
}

function Ellipsis() {
  return <span className="running-bar">…</span>;
}

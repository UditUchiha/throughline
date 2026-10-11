'use client';

import { useEffect, useState } from 'react';
import { Check, Copy, Info, MessageSquareQuote } from 'lucide-react';
import type { Citation } from '@/lib/agent-events';
import { runStages, type RunView } from '@/lib/run-state';
import { Panel } from './Panel';

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
  const writing = runStages(view).answer === 'active';

  return (
    <Panel
      title="Answer"
      icon={MessageSquareQuote}
      highlight
      meta={
        view.status === 'finished' && (
          <>
            {/* Zero citations is a legitimate outcome when the agent declines —
                it is not an error state and must not be dressed as one. */}
            <span>
              {abstained
                ? 'abstained'
                : `${view.citations.length} citation${view.citations.length === 1 ? '' : 's'}`}
            </span>
            {text && <CopyButton text={text} />}
          </>
        )
      }
      bodyClassName="p-4 sm:p-6"
    >
      {!text && streaming && (
        <p className="flex items-center gap-3 text-sm text-muted">
          {writing ? (
            <>
              <TypingDots />
              Writing the answer from the evidence…
            </>
          ) : (
            'The answer appears here once retrieval and reflection are done.'
          )}
        </p>
      )}
      {!text && !streaming && (
        <p className="text-sm text-muted">No answer — the run ended before one was written.</p>
      )}

      {text && (
        <div
          className={`text-base leading-7 whitespace-pre-wrap ${
            abstained ? 'text-muted italic' : 'text-fg'
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
        <p className="mt-4 flex gap-2 border-t border-line pt-4 text-sm leading-relaxed text-muted">
          <Info className="mt-0.5 size-4 shrink-0 text-signal" aria-hidden />
          The corpus contains no answer to this, and abstaining is the correct behaviour — it is a
          scored outcome, not a failure.
        </p>
      )}
    </Panel>
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
            aria-label={`Citation ${match[1]}: show the evidence`}
            className={`mx-0.5 inline-flex h-6 min-w-6 -translate-y-px items-center justify-center rounded-md border px-1.5 align-middle font-mono text-xs font-medium not-italic transition-colors duration-150 ${
              activeEvidenceId === evidenceId
                ? 'border-signal bg-signal text-on-signal'
                : 'border-signal/40 bg-signal/14 text-signal hover:border-signal/70 hover:bg-signal/24'
            }`}
          >
            {match[1]}
          </button>
        );
      })}
    </>
  );
}

/** Copies the answer as written, `[n]` markers included — they mean something pasted elsewhere too. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => {
        // Clipboard access is refused outright on an insecure origin or when the
        // browser denies the permission; the button simply does not confirm.
        navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => undefined,
        );
      }}
      aria-label={copied ? 'Answer copied' : 'Copy answer'}
      title={copied ? 'Copied' : 'Copy answer'}
      className="-my-1 inline-flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-3 hover:text-fg"
    >
      {copied ? (
        <Check className="size-4 text-signal" aria-hidden />
      ) : (
        <Copy className="size-4" aria-hidden />
      )}
    </button>
  );
}

function Caret() {
  return (
    <span
      aria-hidden
      className="running-bar ml-0.5 inline-block h-4 w-0.5 translate-y-0.5 bg-signal"
    />
  );
}

function TypingDots() {
  return (
    <span aria-hidden className="inline-flex items-center gap-1">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="typing-dot size-1.5 rounded-full bg-signal"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

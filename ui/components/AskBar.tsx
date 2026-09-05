'use client';

import { useEffect, useRef } from 'react';

export function AskBar({
  value,
  onChange,
  onSubmit,
  onStop,
  busy,
  demo,
  onDemoChange,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  busy: boolean;
  demo: boolean;
  onDemoChange: (demo: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Clicking an example fills the box; moving focus there shows the visitor the
  // question is editable rather than a fixed menu item.
  useEffect(() => {
    if (value && !busy) inputRef.current?.focus();
  }, [value, busy]);

  return (
    <form
      className="panel p-3 sm:p-4"
      onSubmit={(submitEvent) => {
        submitEvent.preventDefault();
        if (!busy) onSubmit();
      }}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(changeEvent) => onChange(changeEvent.target.value)}
          placeholder="Ask something whose answer is spread across mail, chat and notes…"
          aria-label="Question"
          maxLength={1000}
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-ink-950/70 px-3.5 py-2.5 text-[0.95rem] text-ink-100 outline-none placeholder:text-ink-700 focus:border-signal/60 focus:ring-2 focus:ring-signal/20"
        />

        {busy ? (
          <button
            type="button"
            onClick={onStop}
            className="rounded-lg border border-white/15 bg-ink-850 px-5 py-2.5 text-sm font-medium text-ink-300 transition hover:border-white/25 hover:text-ink-100"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={value.trim().length < 3}
            className="rounded-lg bg-signal px-5 py-2.5 text-sm font-semibold text-ink-950 transition enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35"
          >
            Ask
          </button>
        )}
      </div>

      <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-xs text-ink-500 sm:items-center">
        <input
          type="checkbox"
          checked={demo}
          onChange={(changeEvent) => onDemoChange(changeEvent.target.checked)}
          className="mt-0.5 size-3.5 shrink-0 accent-signal sm:mt-0"
        />
        <span>
          <span className="font-medium text-ink-300">Replay a recorded run</span> — no model calls.
          Free-tier quota is measured in tens of requests per minute and one live run spends about
          four, so this is what keeps the demo working.
        </span>
      </label>
    </form>
  );
}

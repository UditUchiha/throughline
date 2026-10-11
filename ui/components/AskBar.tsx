'use client';

import { useEffect, useRef } from 'react';
import { CornerDownLeft, History, Radio, Search, Square, type LucideIcon } from 'lucide-react';

export function AskBar({
  value,
  onChange,
  onSubmit,
  onStop,
  busy,
  demo,
  onDemoChange,
  followUp,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  busy: boolean;
  demo: boolean;
  onDemoChange: (demo: boolean) => void;
  /** A session exists, so the next question is read against the conversation so far. */
  followUp: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Clicking an example fills the box; moving focus there shows the visitor the
  // question is editable rather than a fixed menu item. `preventScroll` because
  // this also fires when a run finishes, and the visitor is reading the answer
  // further down — a plain focus() would yank them back to the top of the page.
  useEffect(() => {
    if (value && !busy) inputRef.current?.focus({ preventScroll: true });
  }, [value, busy]);

  // "/" jumps to the box from anywhere, the convention search-first tools share.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="space-y-3">
      <form
        className="flex items-center gap-2 rounded-2xl border border-line bg-surface p-2 shadow-[var(--panel-shadow)] transition-[border-color,box-shadow] duration-200 focus-within:border-signal/60 focus-within:shadow-[0_0_0_4px_color-mix(in_oklab,var(--signal)_16%,transparent)]"
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          if (!busy) onSubmit();
        }}
      >
        <Search className="ml-2 size-5 shrink-0 text-faint" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(changeEvent) => onChange(changeEvent.target.value)}
          placeholder={
            followUp
              ? 'Ask a follow-up — it is read against this conversation…'
              : 'Ask something whose answer is spread across mail, chat and notes…'
          }
          aria-label="Question"
          maxLength={1000}
          enterKeyHint="send"
          className="h-11 min-w-0 flex-1 bg-transparent px-1 text-base text-fg outline-none placeholder:text-faint"
        />

        {!value && !busy && (
          <kbd
            aria-hidden
            className="mr-1 hidden h-6 min-w-6 items-center justify-center rounded-md border border-line bg-surface-2 px-1.5 font-mono text-xs text-faint sm:inline-flex"
          >
            /
          </kbd>
        )}

        {busy ? (
          <button
            type="button"
            onClick={onStop}
            className="inline-flex h-11 shrink-0 items-center gap-2 rounded-xl border border-line-strong bg-surface-2 px-4 text-sm font-medium text-fg-2 transition-colors duration-150 hover:bg-surface-3 hover:text-fg"
          >
            <Square className="size-3.5" fill="currentColor" aria-hidden />
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={value.trim().length < 3}
            className="inline-flex h-11 shrink-0 items-center gap-2 rounded-xl bg-signal px-5 text-sm font-semibold text-on-signal transition-[filter,opacity] duration-150 enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Ask
            <CornerDownLeft className="hidden size-4 sm:block" aria-hidden />
          </button>
        )}
      </form>

      <ModeSwitch demo={demo} onDemoChange={onDemoChange} />
    </div>
  );
}

const MODES: {
  demo: boolean;
  label: string;
  icon: LucideIcon;
  selected: string;
  help: string;
}[] = [
  {
    demo: false,
    label: 'Live',
    icon: Radio,
    selected: 'has-checked:bg-signal/14 has-checked:text-signal',
    help: 'Runs the agent for real — about four model calls against a free-tier quota.',
  },
  {
    demo: true,
    label: 'Replay',
    icon: History,
    selected: 'has-checked:bg-warn/14 has-checked:text-warn',
    help: 'Replays a recorded run — the same event stream, no model calls. This is what keeps the demo working when the quota is spent.',
  },
];

/**
 * Live or recorded, as a two-way switch rather than a checkbox.
 *
 * Native radios underneath, so arrow keys move between the two and a screen
 * reader announces "1 of 2" without any ARIA bookkeeping here. The colours match
 * the header's mode pill — signal for live, warn for a recording.
 */
function ModeSwitch({
  demo,
  onDemoChange,
}: {
  demo: boolean;
  onDemoChange: (demo: boolean) => void;
}) {
  const active = MODES.find((mode) => mode.demo === demo) ?? MODES[0];

  return (
    <fieldset className="flex flex-col gap-2 px-1 sm:flex-row sm:items-center sm:gap-4">
      <legend className="sr-only">Run mode</legend>
      <div className="inline-flex w-fit shrink-0 gap-1 rounded-xl border border-line bg-surface-2/60 p-1">
        {MODES.map((mode) => {
          const Icon = mode.icon;
          return (
            <label
              key={mode.label}
              className={`inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-sm font-medium text-muted transition-colors duration-150 hover:text-fg has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-signal ${mode.selected}`}
            >
              <input
                type="radio"
                name="run-mode"
                className="sr-only"
                checked={demo === mode.demo}
                onChange={() => onDemoChange(mode.demo)}
              />
              <Icon className="size-4" aria-hidden />
              {mode.label}
            </label>
          );
        })}
      </div>
      <p className="text-xs leading-relaxed text-muted">{active.help}</p>
    </fieldset>
  );
}

import { Database, Server } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';

/**
 * Three scattered sources joined by one line: the throughline. The same drawing
 * as app/icon.svg, but drawn in theme tokens so it follows light and dark.
 */
export function LogoMark({ className = 'size-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="var(--surface-2)" stroke="var(--line)" />
      <path
        d="M6 22 C 12 22, 12 10, 16 10 S 20 22, 26 22"
        fill="none"
        stroke="var(--signal)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="6" cy="22" r="3.2" fill="var(--mail)" />
      <circle cx="16" cy="10" r="3.2" fill="var(--chat)" />
      <circle cx="26" cy="22" r="3.2" fill="var(--notes)" />
    </svg>
  );
}

export function SiteHeader({
  demo,
  busy,
  turn,
  sessionId,
}: {
  demo: boolean;
  busy: boolean;
  turn: number;
  sessionId: string | null;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-canvas/80 backdrop-blur-lg">
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <LogoMark className="size-7 shrink-0" />
          <span className="font-mono text-base font-semibold tracking-tight text-fg">
            throughline
          </span>
          <span className="hidden truncate border-l border-line pl-2.5 text-sm text-faint md:inline">
            agentic RAG with citations
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Turn 2 onward only: on turn 1 there is no conversation to be in, and a
              badge reading "turn 1" would suggest continuity that does not exist. */}
          {sessionId && turn > 1 && (
            <span
              className="hidden h-7 items-center rounded-full border border-line bg-surface-2/70 px-2.5 font-mono text-xs text-muted sm:inline-flex"
              title={`Session ${sessionId}`}
            >
              turn {turn}
            </span>
          )}

          <span
            className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 font-mono text-xs ${
              demo
                ? 'border-warn/40 bg-warn/14 text-warn'
                : 'border-signal/40 bg-signal/14 text-signal'
            }`}
          >
            <span
              className={`size-1.5 rounded-full ${demo ? 'bg-warn' : 'bg-signal'} ${
                busy ? 'running-bar' : ''
              }`}
              aria-hidden
            />
            {demo ? 'replay' : 'live'}
          </span>

          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

export function SiteFooter({ apiUrl }: { apiUrl: string }) {
  return (
    <footer className="mt-16 border-t border-line">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-6 text-xs leading-relaxed text-faint sm:px-6 md:flex-row md:items-start md:justify-between">
        <p className="flex max-w-2xl gap-2">
          <Database className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            Corpus: &quot;Lumen Labs&quot;, 172 synthetic documents (83 mail / 48 chat / 41 notes)
            built from a hand-authored fact ledger. No real data, no sign-in.
          </span>
        </p>
        <p className="flex shrink-0 gap-2 font-mono">
          <Server className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="break-all">API: {apiUrl}</span>
        </p>
      </div>
    </footer>
  );
}

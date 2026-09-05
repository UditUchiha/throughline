'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  API_URL,
  askStream,
  fetchDemoRuns,
  fetchExamples,
  type DemoRun,
  type ExampleQuestion,
} from '@/lib/api';
import { applyEvent, emptyRun, startRun, type RunView } from '@/lib/run-state';
import { AskBar } from '@/components/AskBar';
import { AnswerPanel } from '@/components/AnswerPanel';
import { EvidencePanel } from '@/components/EvidencePanel';
import { ExampleQuestions } from '@/components/ExampleQuestions';
import { MemoryPanel } from '@/components/MemoryPanel';
import { PlanPanel } from '@/components/PlanPanel';
import { ConnectionBanner, FailureBanner, ReplayBanner } from '@/components/RunBanners';
import { RunStats } from '@/components/RunStats';
import { ToolTimeline } from '@/components/ToolTimeline';
import { TriageCard } from '@/components/TriageCard';

export default function Page() {
  const [question, setQuestion] = useState('');
  const [demo, setDemo] = useState(false);
  const [view, setView] = useState<RunView>(emptyRun);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [examples, setExamples] = useState<ExampleQuestion[]>([]);
  const [demoRuns, setDemoRuns] = useState<DemoRun[]>([]);
  const [focus, setFocus] = useState<{ evidenceId: string; nonce: number } | null>(null);
  const [nowMs, setNowMs] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  /** Monotonic across the whole session — see `cite` below for why it cannot reset. */
  const citeNonce = useRef(0);
  const busy = view.status === 'streaming';

  // `?demo=1` on the UI's own URL preselects replay mode, so the link in the
  // README lands on something that works with the API's quota already spent.
  // Read from `location` rather than `useSearchParams` to keep the page a plain
  // client component with no Suspense boundary standing between it and its data.
  //
  // This cannot become a lazy `useState` initializer: the page is statically
  // prerendered, so the server has no query string and would render `false`
  // while the client rendered `true` — a hydration mismatch. Seeding it after
  // mount is the only option that keeps both renders agreeing, which is exactly
  // the "subscribe to an external system" case the rule below exists to permit.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('demo');
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
    if (requested === '1' || requested === 'true') setDemo(true);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    Promise.all([fetchExamples(controller.signal), fetchDemoRuns(controller.signal)])
      .then(([loadedExamples, loadedDemoRuns]) => {
        setExamples(loadedExamples);
        setDemoRuns(loadedDemoRuns);
        setConnectionError(null);
      })
      .catch((error: unknown) => {
        // An aborted fetch is this effect being cleaned up, not a failure — the
        // one rejection that must never surface as an error to the visitor.
        if (isAbort(error)) return;
        setConnectionError(describe(error));
      });

    return () => controller.abort();
  }, []);

  // Ticks the live latency readout. Driven off wall-clock rather than event
  // timestamps because the interesting stalls are the ones between events.
  //
  // The origin lives on the run (`startedAtMs`) rather than in this effect: `busy`
  // does not change when one streaming run replaces another, so an effect-local
  // start time would silently keep counting from the previous run's beginning.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setNowMs(Date.now()), 100);
    return () => clearInterval(timer);
  }, [busy]);

  const elapsedMs = view.startedAtMs === null ? 0 : Math.max(nowMs - view.startedAtMs, 0);

  // Any in-flight run is abandoned when the tab goes away, so a closed tab stops
  // costing model calls the moment the server sees the socket close.
  useEffect(() => () => abortRef.current?.abort(), []);

  const ask = useCallback(
    (asked: string) => {
      const trimmed = asked.trim();
      if (trimmed.length < 3) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setFocus(null);
      setConnectionError(null);
      setView(startRun(trimmed));

      void (async () => {
        try {
          for await (const event of askStream(trimmed, { demo, signal: controller.signal })) {
            // Aborting does not always surface as a rejection: events already
            // decoded from the last chunk arrive without another read. Without
            // this, Stop could be undone by a buffered `run_finished`, and a
            // reset could be repopulated by the run it just cleared.
            if (controller.signal.aborted) return;
            setView((current) => applyEvent(current, event));
          }
          if (controller.signal.aborted) return;
          // A stream that ends without `run_finished` or `run_failed` was cut
          // short — mid-run the panels would otherwise sit "streaming" forever.
          setView((current) =>
            current.status === 'streaming'
              ? { ...current, status: 'failed', error: 'The event stream ended unexpectedly.' }
              : current,
          );
        } catch (error: unknown) {
          if (isAbort(error) || controller.signal.aborted) return;
          setConnectionError(describe(error));
          setView((current) => ({ ...current, status: 'failed' }));
        }
      })();
    },
    [demo],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setView((current) =>
      current.status === 'streaming'
        ? { ...current, status: 'failed', error: 'Stopped.' }
        : current,
    );
  }, []);

  const handleDemoChange = useCallback((next: boolean) => {
    setDemo(next);
    const url = new URL(window.location.href);
    if (next) url.searchParams.set('demo', '1');
    else url.searchParams.delete('demo');
    window.history.replaceState(null, '', url);
  }, []);

  const cite = useCallback((evidenceId: string) => {
    // The nonce is what makes clicking the same chip twice scroll again — without
    // it the effect sees identical state and does nothing the second time.
    //
    // It counts in a ref rather than from the previous focus because `focus` is
    // cleared when a new run starts while `EvidencePanel` stays mounted: deriving
    // the next value from `current` would restart at 1 and collide with the nonces
    // that panel already recorded as flashed or collapsed, so the first citation
    // of the second run would silently do nothing.
    citeNonce.current += 1;
    setFocus({ evidenceId, nonce: citeNonce.current });
  }, []);

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 sm:py-10">
      <Header demo={demo} busy={busy} />

      <div className="mt-6 space-y-4">
        <AskBar
          value={question}
          onChange={setQuestion}
          onSubmit={() => ask(question)}
          onStop={stop}
          busy={busy}
          demo={demo}
          onDemoChange={handleDemoChange}
        />

        {connectionError && <ConnectionBanner error={connectionError} apiUrl={API_URL} />}
        {view.replay && <ReplayBanner replay={view.replay} />}
        {view.error && !connectionError && <FailureBanner error={view.error} demo={demo} />}

        {view.status === 'idle' && (
          <ExampleQuestions
            examples={examples}
            demoRuns={demoRuns}
            demo={demo}
            disabled={busy}
            onPick={(picked) => {
              setQuestion(picked);
              ask(picked);
            }}
          />
        )}

        {view.status !== 'idle' && (
          <>
            <p className="px-1 text-lg leading-snug font-medium text-balance text-ink-100 sm:text-xl">
              {view.question}
            </p>

            {/* Trace on the left, payoff on the right. On a phone this collapses to
                one column in graph order — triage, plan, retrieval, then answer —
                which is also the order the events arrive in. */}
            <div className="grid gap-4 lg:grid-cols-12 lg:items-start">
              <div className="min-w-0 space-y-4 lg:col-span-5">
                <TriageCard view={view} />
                <PlanPanel view={view} />
                <ToolTimeline view={view} />
                <RunStats view={view} elapsedMs={elapsedMs} />
                <MemoryPanel view={view} />
              </div>

              <div className="min-w-0 space-y-4 lg:col-span-7">
                <AnswerPanel
                  view={view}
                  onCite={cite}
                  activeEvidenceId={focus?.evidenceId ?? null}
                />
                <EvidencePanel view={view} focus={focus} />
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                abortRef.current?.abort();
                setView(emptyRun);
                setFocus(null);
                setQuestion('');
              }}
              className="font-mono text-[0.7rem] text-ink-500 underline decoration-dotted underline-offset-4 transition hover:text-ink-300"
            >
              ask something else
            </button>
          </>
        )}
      </div>

      <Footer />
    </main>
  );
}

function Header({ demo, busy }: { demo: boolean; busy: boolean }) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-100 sm:text-3xl">
          throughline
        </h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-500">
          Agentic RAG over scattered work data. It plans a retrieval strategy, fans out across mail,
          chat and notes, checks its own gaps, and cites the passage behind every claim.
        </p>
      </div>

      <span
        className={`inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[0.65rem] tracking-wide ${
          demo ? 'border-warn/40 bg-warn/10 text-warn' : 'border-signal/40 bg-signal/10 text-signal'
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
    </header>
  );
}

function Footer() {
  return (
    <footer className="mt-10 border-t border-white/8 pt-4 font-mono text-[0.65rem] leading-relaxed text-ink-700">
      <p>
        Corpus: &quot;Lumen Labs&quot;, 169 synthetic documents (82 mail / 47 chat / 40 notes) built
        from a hand-authored fact ledger. No real data, no sign-in.
      </p>
      <p className="mt-1">API: {API_URL}</p>
    </footer>
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function describe(error: unknown): string {
  if (error instanceof TypeError) {
    // `fetch` reports every network-layer failure — DNS, refused connection, a
    // CORS preflight the browser blocked — as an opaque TypeError.
    return `${error.message} (the API may be down, or blocking this origin)`;
  }
  return error instanceof Error ? error.message : String(error);
}

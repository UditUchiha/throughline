'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  API_URL,
  ApiError,
  askStream,
  fetchDemoRuns,
  fetchExamples,
  type DemoRun,
  type ExampleQuestion,
} from '@/lib/api';
import {
  applyEvent,
  emptyRun,
  startRun,
  type ResolvedQuestion,
  type RunView,
} from '@/lib/run-state';
import { clearStoredSession, readStoredSession, storeSession } from '@/lib/session';
import { CornerDownRight, RotateCcw } from 'lucide-react';
import { AskBar } from '@/components/AskBar';
import { AnswerPanel } from '@/components/AnswerPanel';
import { EvidencePanel } from '@/components/EvidencePanel';
import { ExampleQuestions } from '@/components/ExampleQuestions';
import { HeroQuestion, heroIsReplayable, isHeroQuestion } from '@/components/HeroQuestion';
import { HowItWorks, Intro } from '@/components/Landing';
import { MemoryPanel } from '@/components/MemoryPanel';
import { PlanPanel } from '@/components/PlanPanel';
import {
  ColdStartBanner,
  ConnectionBanner,
  FailureBanner,
  ReplayBanner,
} from '@/components/RunBanners';
import { RunProgress } from '@/components/RunProgress';
import { RunStats } from '@/components/RunStats';
import { SiteFooter, SiteHeader } from '@/components/SiteChrome';
import { ToolTimeline } from '@/components/ToolTimeline';
import { TriageCard } from '@/components/TriageCard';

/**
 * How long the first fetch may take before the page admits the API is asleep.
 *
 * A warm instance answers in tens of milliseconds, so anything past a couple of
 * seconds is a cold start rather than a slow network — and three seconds is short
 * enough that the visitor has not yet concluded the page is broken.
 */
const COLD_START_HINT_MS = 3000;

export default function Page() {
  const [question, setQuestion] = useState('');
  const [demo, setDemo] = useState(false);
  const [view, setView] = useState<RunView>(emptyRun);
  const [connectionError, setConnectionError] = useState<ConnectionFailure | null>(null);
  /**
   * The first fetch is taking long enough that the API is probably asleep.
   *
   * A flag rather than "loading", because a fast answer should show nothing at
   * all — a banner that flashes on every page load is noise. It is only worth
   * saying once the wait is long enough for a visitor to start wondering.
   */
  const [waking, setWaking] = useState(false);
  const [examples, setExamples] = useState<ExampleQuestion[]>([]);
  const [demoRuns, setDemoRuns] = useState<DemoRun[]>([]);
  const [focus, setFocus] = useState<{ evidenceId: string; nonce: number } | null>(null);
  const [nowMs, setNowMs] = useState(0);
  /**
   * The conversation this tab is in.
   *
   * Held here rather than inside `view`, which is one run: the whole point is
   * that it outlives a run. The API mints it on the first question and reports it
   * on `run_started`, so this starts null and is never generated locally — two
   * sides inventing session ids is how you get a conversation the server does not
   * think exists. Mirrored into `sessionStorage` so a refresh does not silently
   * start a new conversation (PLAN.md §11.8).
   */
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turn, setTurn] = useState(0);

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

  // Restores the conversation after a refresh. Same constraint as the effect
  // above — `sessionStorage` does not exist during prerender, so reading it in a
  // `useState` initializer would render one thing on the server and another on
  // the client. The run itself is not restored, only the thread it belongs to:
  // re-streaming a finished run would cost model calls to redraw a panel.
  useEffect(() => {
    const stored = readStoredSession();
    if (!stored) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
    setSessionId(stored.sessionId);
    setTurn(stored.turn);
  }, []);

  // Mirrors the conversation into `sessionStorage` whenever it changes.
  //
  // An effect rather than a write inside the `setTurn` updater below, which is
  // where this started. React treats updaters as pure and may run one twice, or
  // for a render it then throws away — so a storage write in there can persist a
  // turn count that never became state. Keyed on both values, so it records
  // whatever the state actually settled on, and skipped while there is no
  // session so that the reset button's `clearStoredSession` is not immediately
  // undone.
  useEffect(() => {
    if (!sessionId) return;
    storeSession({ sessionId, turn });
  }, [sessionId, turn]);

  useEffect(() => {
    const controller = new AbortController();

    // This fetch is also the wake-up call. On a free tier that sleeps after 15
    // idle minutes the container starts spinning up the moment the page loads,
    // so the ~50s overlaps with the visitor reading the page instead of landing
    // on their first question. Announced only after a few seconds, because a warm
    // instance answers in milliseconds and a banner that always flashes says
    // nothing.
    const wakingTimer = setTimeout(() => setWaking(true), COLD_START_HINT_MS);
    const settle = () => {
      clearTimeout(wakingTimer);
      setWaking(false);
    };

    Promise.all([fetchExamples(controller.signal), fetchDemoRuns(controller.signal)])
      .then(([loadedExamples, loadedDemoRuns]) => {
        settle();
        setExamples(loadedExamples);
        setDemoRuns(loadedDemoRuns);
        setConnectionError(null);
      })
      .catch((error: unknown) => {
        settle();
        // An aborted fetch is this effect being cleaned up, not a failure — the
        // one rejection that must never surface as an error to the visitor.
        if (isAbort(error)) return;
        setConnectionError(describeConnectionFailure(error));
      });

    return () => {
      clearTimeout(wakingTimer);
      controller.abort();
    };
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

  // In replay mode the hero question can only be offered if a fixture exists for
  // it; live, the API can answer anything in the corpus. Rendering it regardless
  // would put a button that 404s on the most prominent surface of the page.
  const heroAvailable = !demo || heroIsReplayable(demoRuns);

  // The hero is rendered above these, so leaving it in the list below shows the
  // same question twice. Filtered rather than hidden in the child, because the
  // child has no idea a hero exists.
  const otherDemoRuns = heroAvailable
    ? demoRuns.filter((run) => !isHeroQuestion(run.question))
    : demoRuns;
  const otherExamples = heroAvailable
    ? examples.filter((example) => !isHeroQuestion(example.question))
    : examples;

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
      setView(startRun(trimmed, sessionId));

      void (async () => {
        try {
          for await (const event of askStream(trimmed, {
            demo,
            sessionId: sessionId ?? undefined,
            signal: controller.signal,
          })) {
            // Aborting does not always surface as a rejection: events already
            // decoded from the last chunk arrive without another read. Without
            // this, Stop could be undone by a buffered `run_finished`, and a
            // reset could be repopulated by the run it just cleared.
            if (controller.signal.aborted) return;
            // Adopting the server's id is what turns the *next* question into a
            // follow-up. A replay reports none, and must not end a live session.
            if (event.type === 'run_started' && event.sessionId) {
              const started = event.sessionId;
              setSessionId(started);
              // Derived from the previous count rather than from `turn` directly,
              // so a second question started before the first finished still
              // lands on the right number. Persisting happens in an effect — see
              // where `storeSession` is called.
              setTurn((count) => (started === sessionId ? count + 1 : 1));
            }
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
          setConnectionError(describeConnectionFailure(error));
          setView((current) => ({ ...current, status: 'failed' }));
        }
      })();
    },
    [demo, sessionId],
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

  const idle = view.status === 'idle';

  const pick = (picked: string) => {
    setQuestion(picked);
    ask(picked);
  };

  return (
    <>
      <SiteHeader demo={demo} busy={busy} turn={turn} sessionId={sessionId} />

      <main className="mx-auto w-full max-w-7xl px-4 sm:px-6">
        {idle && <Intro />}

        <div className={`space-y-5 ${idle ? 'mt-8 sm:mt-10' : 'mt-6 sm:mt-8'}`}>
          <AskBar
            value={question}
            onChange={setQuestion}
            onSubmit={() => ask(question)}
            onStop={stop}
            busy={busy}
            demo={demo}
            onDemoChange={handleDemoChange}
            followUp={sessionId !== null}
          />

          {waking && !connectionError && <ColdStartBanner apiUrl={API_URL} />}
          {connectionError && (
            <ConnectionBanner
              error={connectionError.message}
              status={connectionError.status}
              apiUrl={API_URL}
            />
          )}
          {view.replay && <ReplayBanner replay={view.replay} />}
          {view.error && !connectionError && <FailureBanner error={view.error} demo={demo} />}

          {idle && (
            <>
              <div className="grid gap-5 lg:grid-cols-12">
                <HeroQuestion
                  demo={demo}
                  disabled={busy}
                  available={heroAvailable}
                  onPick={pick}
                  className="lg:col-span-7"
                />
                <HowItWorks
                  wide={!heroAvailable}
                  className={heroAvailable ? 'lg:col-span-5' : 'lg:col-span-12'}
                />
              </div>

              <ExampleQuestions
                examples={otherExamples}
                demoRuns={otherDemoRuns}
                demo={demo}
                disabled={busy}
                onPick={pick}
              />
            </>
          )}

          {!idle && (
            <>
              <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                <div className="min-w-0 space-y-2">
                  <p className="eyebrow text-faint">Question</p>
                  <h1 className="text-xl leading-snug font-semibold text-balance text-fg sm:text-2xl">
                    {view.question}
                  </h1>
                  {view.resolvedQuestion && <ResolvedQuestionNote resolved={view.resolvedQuestion} />}
                </div>

                {/* Asking another question in the bar above *continues* the session,
                    which is the behaviour worth having by default. This is the way
                    out of it: a visitor who has moved on to an unrelated subject
                    should not have their pronouns resolved against the old one. */}
                <button
                  type="button"
                  onClick={() => {
                    abortRef.current?.abort();
                    setView(emptyRun);
                    setFocus(null);
                    setQuestion('');
                    setSessionId(null);
                    setTurn(0);
                    clearStoredSession();
                  }}
                  className="inline-flex h-10 w-fit shrink-0 items-center gap-2 rounded-lg border border-line bg-surface/70 px-3.5 text-sm text-fg-2 transition-colors duration-150 hover:border-line-strong hover:text-fg"
                >
                  <RotateCcw className="size-4" aria-hidden />
                  New session
                </button>
              </div>

              <RunProgress view={view} elapsedMs={elapsedMs} />

              {/* Trace on the left, payoff on the right. On a phone this collapses to
                  one column in graph order — triage, plan, retrieval, then answer —
                  which is also the order the events arrive in. */}
              <div className="grid gap-5 lg:grid-cols-12 lg:items-start">
                <div className="min-w-0 space-y-5 lg:col-span-5">
                  <TriageCard view={view} />
                  <PlanPanel view={view} />
                  <ToolTimeline view={view} />
                  <RunStats view={view} elapsedMs={elapsedMs} />
                  <MemoryPanel view={view} />
                </div>

                <div className="min-w-0 space-y-5 lg:col-span-7">
                  <AnswerPanel
                    view={view}
                    onCite={cite}
                    activeEvidenceId={focus?.evidenceId ?? null}
                  />
                  <EvidencePanel view={view} focus={focus} />
                </div>
              </div>
            </>
          )}
        </div>
      </main>

      <SiteFooter apiUrl={API_URL} />
    </>
  );
}

/**
 * What `recall` did, shown next to what was typed.
 *
 * Every other panel on the page describes the *resolved* question, so without
 * this a follow-up looks like the agent answering something the visitor did not
 * ask. Rendering both is also the only way to catch it resolving one wrongly.
 */
function ResolvedQuestionNote({ resolved }: { resolved: ResolvedQuestion }) {
  return (
    <p className="flex items-start gap-1.5 text-sm leading-relaxed text-muted">
      <CornerDownRight className="mt-0.5 size-4 shrink-0 text-faint" aria-hidden />
      <span>
        <span className="font-mono text-xs text-faint">read as</span> {resolved.resolved}
      </span>
    </p>
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * A connection failure, kept as a struct rather than two states that have to
 * change together. `status` is what `ConnectionBanner` needs to stop guessing at
 * a cause: `null` is a genuine network-layer failure (fetch never got a
 * response), a number is exactly what the API said.
 */
interface ConnectionFailure {
  message: string;
  status: number | null;
}

function describeConnectionFailure(error: unknown): ConnectionFailure {
  if (error instanceof ApiError) return { message: error.message, status: error.status };

  if (error instanceof TypeError) {
    // `fetch` reports every network-layer failure — DNS, refused connection, a
    // CORS preflight the browser blocked — as an opaque TypeError, and none of
    // them carries a status: there was no response to have one.
    return {
      message: `${error.message} (the API may be down, or blocking this origin)`,
      status: null,
    };
  }
  return { message: error instanceof Error ? error.message : String(error), status: null };
}

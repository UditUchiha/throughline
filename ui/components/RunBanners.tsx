'use client';

import { History, Hourglass, LoaderCircle, OctagonAlert, Unplug } from 'lucide-react';
import type { ReplayInfo } from '@/lib/run-state';
import { connectionCause, formatCapturedAt } from '@/lib/presentation';
import { Callout } from './Callout';

/**
 * The replay banner.
 *
 * `run_replayed` always arrives first on a recording and never on a live run,
 * which is the API's honesty mechanism for PLAN.md §9's degraded demo: a
 * recording cannot present itself as live. Rendering it is the other half of
 * that contract, so this is not decoration — dropping it would break the promise.
 */
export function ReplayBanner({ replay }: { replay: ReplayInfo }) {
  return (
    <Callout tone="warn" icon={History} title="Recorded run.">
      <p>
        {replay.reason === 'quota_exhausted'
          ? 'The live provider was out of quota, so a captured run is being replayed instead.'
          : 'Replaying a captured run — no model was called.'}
      </p>
      <p className="font-mono text-xs text-muted">
        {replay.slug} · captured {formatCapturedAt(replay.capturedAt)}
      </p>
    </Callout>
  );
}

/**
 * A mid-stream failure. `run_failed` is a real event, not a theoretical one —
 * free-tier quota is the usual cause even with a fallback chain configured — so
 * it gets a message rather than a blank screen.
 */
export function FailureBanner({ error, demo }: { error: string; demo: boolean }) {
  return (
    <Callout tone="danger" icon={OctagonAlert} title="The run failed." urgent>
      <p className="font-mono text-xs leading-relaxed wrap-break-word">{error}</p>
      {!demo && (
        <p className="text-muted">
          Free-tier quota is the usual cause. Switch to <ModeName>Replay</ModeName> above to watch
          a captured run instead — it makes no model calls.
        </p>
      )}
    </Callout>
  );
}

/**
 * Whether the API is a local dev server or a deployed one.
 *
 * The two failure modes read identically over the wire and want opposite advice:
 * locally the API is usually not running, and on the deployed free tier it is
 * asleep and about to wake. Telling a visitor to run `pnpm start:dev` against a
 * public URL is advice they cannot act on.
 */
function isLocalApi(apiUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$|\/)/.test(apiUrl);
}

/**
 * The API is asleep and waking up.
 *
 * PLAN.md §9 rejected Render precisely for this — "exactly the wrong behaviour
 * when a reviewer clicks your link" — and it is what the free tier costs now that
 * Hugging Face charges for Docker Spaces. A ~50s wait is survivable; a *silent*
 * ~50s wait that then resolves into a red error banner is not, and that is what
 * the visitor would otherwise see.
 *
 * Nothing here speeds the cold start up. The page load already does that, by
 * fetching the examples on mount so the spin-up overlaps with the visitor reading
 * the page rather than following their first question.
 */
export function ColdStartBanner({ apiUrl }: { apiUrl: string }) {
  return (
    <Callout tone="warn" icon={LoaderCircle} spin title="Waking the API…">
      <p>
        {isLocalApi(apiUrl)
          ? 'Waiting for the local server to answer.'
          : 'It sleeps after 15 idle minutes on the free tier and takes up to a minute to come back. Nothing is wrong.'}
      </p>
    </Callout>
  );
}

/**
 * Distinct from a failed run: the API itself was unreachable or rejected the
 * request before a run ever started.
 *
 * The footer used to say one thing regardless of *why* — "runs on a free tier
 * that sleeps" — for every non-local failure, including a 429. Confirmed live on
 * 2026-09-20: a visitor who spent the rate-limit budget saw that sentence next
 * to the literal text `ThrottlerException: Too Many Requests`, which contradicts
 * it — the instance was warm the whole time. `status` is what tells the three
 * causes apart: a rate limit, a genuine network failure (`null` — there was no
 * response to have a status), and anything else the API returned.
 */
export function ConnectionBanner({
  error,
  apiUrl,
  status,
}: {
  error: string;
  apiUrl: string;
  status: number | null;
}) {
  const cause = connectionCause(isLocalApi(apiUrl), status);
  const rateLimited = cause === 'rate-limited';

  return (
    <Callout
      tone="danger"
      icon={rateLimited ? Hourglass : Unplug}
      title={rateLimited ? 'Rate limit reached.' : 'Could not reach the API.'}
      urgent
    >
      <p className="font-mono text-xs leading-relaxed wrap-break-word">{error}</p>
      {cause === 'local-dev' && (
        <p className="text-muted">
          Expecting it at <Mono>{apiUrl}</Mono>. Start it with <Mono>pnpm start:dev</Mono>, or
          point <Mono>NEXT_PUBLIC_API_URL</Mono> somewhere else.
        </p>
      )}
      {rateLimited && (
        <p className="text-muted">
          This demo allows 5 questions every 10 minutes per visitor, to keep the free-tier quota
          available for everyone trying it. Switch to <ModeName>Replay</ModeName> to keep exploring
          for free, or wait a few minutes and ask again.
        </p>
      )}
      {cause === 'no-response' && (
        <p className="text-muted">
          <Mono>{apiUrl}</Mono> runs on a free tier that sleeps after 15 idle minutes. A reload
          usually catches it once it has woken.
        </p>
      )}
      {cause === 'api-error' && (
        <p className="text-muted">
          The API responded with an error rather than an answer — see the message above.
        </p>
      )}
    </Callout>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-fg-2">{children}</span>;
}

function ModeName({ children }: { children: React.ReactNode }) {
  return <span className="font-medium text-fg-2">{children}</span>;
}

import { Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request } from 'express';
import { AppConfigService } from '../config/app-config.service';

/**
 * Whether this request is a recorded-run replay rather than a live run.
 *
 * Shared with `AgentController` because the two must agree: a request the
 * controller replays for free but the limiter counts as a live question would
 * spend a visitor's budget on a fixture, and the reverse would leave the
 * expensive path unmetered. One predicate, two callers.
 */
export function isDemoReplay(demo: string | undefined): boolean {
  return demo === '1' || demo === 'true';
}

/**
 * The client identity a request counts against.
 *
 * Prefers Cloudflare's `CF-Connecting-IP` over the hop-counted `request.ip`,
 * when it is present. This exists because of a live finding, not a hypothetical:
 * verified against the deployed instance on 2026-09-20, Render's edge sits
 * behind Cloudflare — an additional proxy hop `TRUST_PROXY_HOPS` was never told
 * about — and `request.ip` did not resolve to a stable per-visitor address. A
 * controlled sequence of requests from one caller, one second apart, landed in
 * visibly different buckets: a limit of 5 was exhausted in three requests, and
 * the very next request reset to a fresh-looking one. A caller that can get a
 * new identity by chance is one the limiter is not actually rationing.
 *
 * `CF-Connecting-IP` is set — and overwritten — at Cloudflare's edge, so a
 * client cannot forge it as long as Cloudflare is the real ingress, which is
 * the deployed topology's actual shape regardless of what `TRUST_PROXY_HOPS`
 * is told. Checking for the header's presence rather than the hostname or an
 * env flag is what keeps this host-neutral: Northflank, Cloud Run and a Docker
 * Space have no Cloudflare in front and never send it, so they fall through to
 * `request.ip` exactly as before, unchanged.
 *
 * Exported, and kept separate from `getTracker`, for the same reason
 * `isDemoReplay` is: `ThrottlerGuard`'s protected methods are awkward to call
 * directly in a test, and this is the part actually worth pinning.
 */
export function resolveTracker(request: Pick<Request, 'ip' | 'headers'>): string {
  const cfConnectingIp = request.headers['cf-connecting-ip'];
  if (typeof cfConnectingIp === 'string' && cfConnectingIp.length > 0) return cfConnectingIp;

  // `req.ip` is undefined only when the socket has already gone; bucketing
  // those together is harmless because such a request is not going to run.
  return request.ip ?? 'unknown';
}

/**
 * The rate limit on `POST /agent/ask` (PLAN.md §9).
 *
 * The endpoint is unauthenticated and CORS is open by design — `main.ts` argues
 * that, and the argument still holds: there is no sign-in and no credentials, so
 * a permissive origin is honest rather than lax. What was missing is the other
 * half. An open endpoint that spends ~4 model calls per request against a free
 * tier measured in tens per window can be exhausted by one visitor holding down
 * a key, and `DEMO_MODE` keeping the deployed instance corpus-only is a default
 * protecting that endpoint rather than a control on it.
 *
 * Two deliberate departures from the stock guard:
 *
 * **Replays are not counted.** `?demo=1` streams a committed fixture and makes
 * no model calls, so it costs nothing worth rationing — and it is the fallback a
 * visitor is pushed towards when the quota *is* gone. Metering it would take the
 * degraded path away at exactly the moment it matters.
 *
 * **The limit can be switched off rather than set high.** `RATE_LIMIT_ENABLED`
 * exists because a limit expressed as an enormous number still reads like a
 * limit to whoever finds it next, and local development wants no limit at all.
 *
 * The tracker prefers Cloudflare's `CF-Connecting-IP` header and falls back to
 * `request.ip`, which is only correct because `main.ts` sets Express's
 * `trust proxy` from `TRUST_PROXY_HOPS`. Behind a platform proxy with that
 * unset, every request arrives from the proxy and the whole internet shares one
 * bucket — the limiter would work perfectly and lock everyone out together. See
 * {@link resolveTracker} for why the header takes precedence.
 */
@Injectable()
export class AskThrottlerGuard extends ThrottlerGuard {
  // The two decorators are not optional. `ThrottlerModuleOptions` and
  // `ThrottlerStorage` are interfaces, so `emitDecoratorMetadata` records them as
  // `Object` and Nest has nothing to resolve — the base class supplies these
  // tokens itself, and a subclass that redeclares the constructor has to supply
  // them again or fail to instantiate at boot.
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly config: AppConfigService,
  ) {
    super(options, storageService, reflector);
  }

  protected shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (!this.config.rateLimitEnabled) return Promise.resolve(true);

    // Narrowed rather than cast: Express hands back `string | string[] | ParsedQs`,
    // and `?demo=1&demo=2` would otherwise arrive here as an array claiming to be
    // a string. Anything that is not a plain string is not a replay request.
    const { demo } = context.switchToHttp().getRequest<Request>().query;
    return Promise.resolve(isDemoReplay(typeof demo === 'string' ? demo : undefined));
  }

  protected getTracker(request: Request): Promise<string> {
    return Promise.resolve(resolveTracker(request));
  }
}

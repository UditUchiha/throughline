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
 * The tracker is the client IP, which is only correct because `main.ts` sets
 * Express's `trust proxy` from `TRUST_PROXY_HOPS`. Behind a platform proxy with
 * that unset, every request arrives from the proxy and the whole internet shares
 * one bucket — the limiter would work perfectly and lock everyone out together.
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
    // `req.ip` is undefined only when the socket has already gone; bucketing
    // those together is harmless because such a request is not going to run.
    return Promise.resolve(request.ip ?? 'unknown');
  }
}

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  // The M2 UI is deployed separately (Vercel) from the API, so the browser always
  // makes a cross-origin request. No credentials are involved — there is no
  // sign-in — so a permissive origin is the honest configuration.
  //
  // Open CORS is not the missing control it can look like: it decides which
  // *origins* a browser will hand the response to, and offers nothing against a
  // caller that is not a browser. The control on this endpoint is the rate limit
  // in `AskThrottlerGuard`, which applies to every caller equally.
  app.enableCors({ origin: true });

  // Lets LangSmithTracing flush whatever traces are still batched on the way out.
  // Without this the last run before a Ctrl-C is the one that never shows up.
  app.enableShutdownHooks();

  const config = app.get(AppConfigService);

  // How many reverse proxies to believe about the client's address.
  //
  // This is what makes the rate limit on `POST /agent/ask` per *visitor*. Behind
  // a platform proxy every request arrives from the proxy's address, so at 0 the
  // limiter buckets the entire internet together and one visitor's five
  // questions lock out everyone else — a limit that works exactly as designed
  // and is useless. Trusting more hops than exist is the mirror failure:
  // `X-Forwarded-For` is client-supplied, so an over-long chain lets a caller
  // mint a fresh identity per request.
  //
  // A count rather than `true`, for that reason. `TRUST_PROXY_HOPS` defaults to
  // 1, which is right for a single platform proxy; set it to 0 when the API is
  // reached directly. Render is the one documented exception — it sits behind
  // Cloudflare too, an extra hop this number does not see — and
  // `AskThrottlerGuard.resolveTracker` covers that case with Cloudflare's own
  // header rather than a bigger number here. See the comment on
  // `TRUST_PROXY_HOPS` in env.schema.ts for what was actually observed.
  app.set('trust proxy', config.trustProxyHops);

  // Bound to every interface, not just loopback. A container's port mapping
  // reaches it from outside the container, and a server listening on 127.0.0.1
  // inside one is unreachable in a way that looks like a crashed process — the
  // platform's health check times out while the logs say it started fine.
  await app.listen(config.port, '0.0.0.0');
}
void bootstrap();

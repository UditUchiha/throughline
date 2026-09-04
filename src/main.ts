import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  // The M2 UI is deployed separately (Vercel) from the API (HF Spaces), so the
  // browser always makes a cross-origin request. No credentials are involved —
  // there is no sign-in — so a permissive origin is the honest configuration.
  app.enableCors({ origin: true });

  const config = app.get(AppConfigService);
  await app.listen(config.port);
}
void bootstrap();

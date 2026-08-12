import { NestFactory } from '@nestjs/core';
import { verifierUrlsServices } from '@esfl/contracts';
import { AppModule } from './app.module';

async function bootstrap() {
  // Stats des matchs → data, compositions des ligues → fantasy.
  verifierUrlsServices(['DATA_SERVICE_URL', 'FANTASY_SERVICE_URL'], process.env);
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 4004);
  await app.listen(port);
  console.log(`[scoring-service] à l'écoute sur le port ${port}`);
}

void bootstrap();

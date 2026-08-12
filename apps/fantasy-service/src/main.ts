import { NestFactory } from '@nestjs/core';
import { verifierUrlsServices } from '@esfl/contracts';
import { AppModule } from './app.module';

async function bootstrap() {
  // Catalogue des matchs → data, re-scores à la composition → scoring.
  verifierUrlsServices(['DATA_SERVICE_URL', 'SCORING_SERVICE_URL'], process.env);
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 4003);
  await app.listen(port);
  console.log(`[fantasy-service] à l'écoute sur le port ${port}`);
}

void bootstrap();

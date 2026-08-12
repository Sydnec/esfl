import { NestFactory } from '@nestjs/core';
import { verifierUrlsServices } from '@esfl/contracts';
import { AppModule } from './app.module';

async function bootstrap() {
  // Fusion de fiches joueur → scoring, ciblage de l'ingestion → fantasy.
  verifierUrlsServices(['FANTASY_SERVICE_URL', 'SCORING_SERVICE_URL'], process.env);
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 4002);
  await app.listen(port);
  console.log(`[data-service] à l'écoute sur le port ${port}`);
}

void bootstrap();

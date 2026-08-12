import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { verifierUrlsServices } from '@esfl/contracts';
import { AppModule } from './app.module';

async function bootstrap() {
  // Suppression de compte : nettoyage chez fantasy et scoring.
  verifierUrlsServices(['FANTASY_SERVICE_URL', 'SCORING_SERVICE_URL'], process.env);
  const app = await NestFactory.create(AppModule);
  app.use(cookieParser());
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 4001);
  await app.listen(port);
  console.log(`[auth-service] à l'écoute sur le port ${port}`);
}

void bootstrap();

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 4004);
  await app.listen(port);
  console.log(`[scoring-service] à l'écoute sur le port ${port}`);
}

void bootstrap();

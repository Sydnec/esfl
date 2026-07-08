import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 4003);
  await app.listen(port);
  console.log(`[fantasy-service] à l'écoute sur le port ${port}`);
}

void bootstrap();

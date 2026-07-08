import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(cookieParser());
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 4001);
  await app.listen(port);
  console.log(`[auth-service] à l'écoute sur le port ${port}`);
}

void bootstrap();

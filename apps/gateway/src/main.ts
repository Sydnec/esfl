import { NestFactory } from '@nestjs/core';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { verify } from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  // bodyParser désactivé : le gateway ne fait que proxyfier, un body déjà
  // consommé casserait le stream vers les services.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.enableShutdownHooks();
  app.enableCors({
    origin: process.env.FRONTEND_URL ?? 'http://localhost:3000',
    credentials: true,
  });

  // Contexte utilisateur : un Bearer token valide devient un en-tête x-user-id
  // pour les services internes. Les x-user-* entrants sont toujours écrasés.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    delete req.headers['x-user-id'];
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      try {
        const payload = verify(header.slice(7), process.env.JWT_ACCESS_SECRET ?? '') as {
          sub?: string;
        };
        if (payload.sub) {
          req.headers['x-user-id'] = payload.sub;
        }
      } catch {
        // token invalide ou expiré : la requête reste anonyme
      }
    }
    next();
  });

  const routes: Array<[prefix: string, target: string]> = [
    ['/auth', process.env.AUTH_SERVICE_URL ?? 'http://localhost:4001'],
    ['/data', process.env.DATA_SERVICE_URL ?? 'http://localhost:4002'],
    ['/fantasy', process.env.FANTASY_SERVICE_URL ?? 'http://localhost:4003'],
    ['/scoring', process.env.SCORING_SERVICE_URL ?? 'http://localhost:4004'],
  ];
  for (const [prefix, target] of routes) {
    // Express retire le préfixe au montage : la cible le réintègre.
    app.use(prefix, createProxyMiddleware({ target: `${target}${prefix}`, changeOrigin: true }));
  }

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  console.log(`[gateway] à l'écoute sur le port ${port}`);
}

void bootstrap();

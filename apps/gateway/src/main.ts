import { NestFactory } from '@nestjs/core';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { AppModule } from './app.module';
import { bloquerRoutesInternes, contexteUtilisateur } from './user-context';

async function bootstrap() {
  // Secret JWT obligatoire : sans lui, `verify` avec une clé vide accepterait
  // des tokens forgés (dont isAdmin) — on échoue au démarrage plutôt que fail-open.
  const jwtSecret = process.env.JWT_ACCESS_SECRET;
  if (!jwtSecret) {
    throw new Error('JWT_ACCESS_SECRET manquant : le gateway ne peut pas vérifier les tokens');
  }

  // bodyParser désactivé : le gateway ne fait que proxyfier, un body déjà
  // consommé casserait le stream vers les services.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.enableShutdownHooks();
  app.enableCors({
    origin: process.env.FRONTEND_URL ?? 'http://localhost:3000',
    credentials: true,
  });

  // Ces deux middlewares portent la sécurité du gateway et vivent à part pour
  // être testés unitairement (cf. `user-context.spec.ts`).
  app.use(bloquerRoutesInternes);
  app.use(contexteUtilisateur(jwtSecret));

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

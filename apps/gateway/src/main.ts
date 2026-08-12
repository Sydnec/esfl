import { NestFactory } from '@nestjs/core';
import { verifierUrlsServices } from '@esfl/contracts';
import { createProxyMiddleware } from 'http-proxy-middleware';
import rateLimit from 'express-rate-limit';
import { AppModule } from './app.module';
import { bloquerRoutesInternes, contexteUtilisateur } from './user-context';

async function bootstrap() {
  // Secret JWT obligatoire : sans lui, `verify` avec une clé vide accepterait
  // des tokens forgés (dont isAdmin) — on échoue au démarrage plutôt que fail-open.
  const jwtSecret = process.env.JWT_ACCESS_SECRET;
  if (!jwtSecret) {
    throw new Error('JWT_ACCESS_SECRET manquant : le gateway ne peut pas vérifier les tokens');
  }

  // Même raisonnement pour les cibles du proxy : sans elles, tout le trafic
  // public partirait sur le conteneur du gateway.
  verifierUrlsServices(
    ['AUTH_SERVICE_URL', 'DATA_SERVICE_URL', 'FANTASY_SERVICE_URL', 'SCORING_SERVICE_URL'],
    process.env,
  );

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

  // Anti-brute-force sur les points d'authentification sensibles (login,
  // inscription). Derrière le tunnel Cloudflare, l'IP source vue par Express est
  // 127.0.0.1 (cloudflared) : on clé sur `CF-Connecting-IP` (posé par
  // Cloudflare), avec repli sur X-Forwarded-For puis req.ip en local.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { message: 'Trop de tentatives, réessayez plus tard.' },
    keyGenerator: (req) => {
      const cf = req.headers['cf-connecting-ip'];
      if (typeof cf === 'string' && cf.length > 0) return cf;
      const xff = req.headers['x-forwarded-for'];
      if (typeof xff === 'string' && xff.length > 0) {
        const first = xff.split(',')[0]?.trim();
        if (first) return first;
      }
      return req.ip ?? 'inconnu';
    },
    // req.ip est toujours loopback derrière le tunnel : les validations
    // trust-proxy / X-Forwarded-For d'express-rate-limit ne s'appliquent pas.
    validate: false,
  });
  app.use(['/auth/login', '/auth/register'], authLimiter);

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

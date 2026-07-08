# Déploiement ESFL

Backend (5 micro-services + Postgres + Redis + Caddy) sur un VPS via Docker Compose,
frontend Next.js sur Vercel.

## 1. Prérequis

- Un VPS avec Docker + le plugin compose, et un nom de domaine.
- DNS : un enregistrement A `api.mondomaine.fr` → IP du VPS.
- Comptes externes :
  - **Pandascore** : token API (gratuit) → `PANDASCORE_TOKEN`
  - **Discord** : application OAuth (redirect `https://api.mondomaine.fr/auth/oauth/discord/callback`)
  - **Google** : OAuth client (redirect `https://api.mondomaine.fr/auth/oauth/google/callback`)
  - **Grid.gg Open Access** (optionnel, stats CS2) → `GRID_API_KEY`

## 2. Backend sur le VPS

```bash
git clone <repo> esfl && cd esfl
cp .env.example .env
```

Variables à renseigner dans `.env` (celles utilisées par `docker-compose.yml`) :

```env
POSTGRES_PASSWORD=<fort et aléatoire>
JWT_ACCESS_SECRET=<openssl rand -hex 32>
JWT_REFRESH_SECRET=<openssl rand -hex 32>
FRONTEND_URL=https://esfl.vercel.app        # ou ton domaine
API_DOMAIN=api.mondomaine.fr
OAUTH_CALLBACK_BASE_URL=https://api.mondomaine.fr
COOKIE_SAMESITE=none                        # front et API sur des domaines différents
PANDASCORE_TOKEN=...
DISCORD_CLIENT_ID=... / DISCORD_CLIENT_SECRET=...
GOOGLE_CLIENT_ID=... / GOOGLE_CLIENT_SECRET=...
```

> Si le front et l'API partagent le même domaine racine (ex: `esfl.fr` et
> `api.esfl.fr`), préférer `COOKIE_SAMESITE=lax`.

Puis :

```bash
docker compose up -d --build
docker compose logs -f gateway    # vérifier le démarrage
curl https://api.mondomaine.fr/health
```

Les migrations Prisma s'appliquent automatiquement au démarrage de chaque
service (`prisma migrate deploy`). L'ingestion Pandascore démarre seule si
`PANDASCORE_TOKEN` est présent (séries 6h / matchs 10 min / rosters 12h).

## 3. Frontend sur Vercel

1. Importer le repo dans Vercel.
2. **Root Directory** : `apps/web` (activer « Include source files outside of the
   Root Directory » — nécessaire au monorepo pnpm).
3. Variable d'environnement : `NEXT_PUBLIC_API_URL=https://api.mondomaine.fr`.
4. Déployer. Reporter l'URL finale dans `FRONTEND_URL` du VPS puis
   `docker compose up -d gateway auth-service` pour recharger.

## 4. Mise à jour

```bash
git pull && docker compose up -d --build
```

## Suivi restant

- Brancher les providers de stats détaillées (`apps/data-service/src/stats/stats-ingestion.ts`) :
  Grid.gg (CS2), VLR.gg (Valorant), Leaguepedia (LoL), Octane zsr (RL).
  Sans eux, les points ne peuvent être calculés qu'à partir de stats déjà présentes en base.

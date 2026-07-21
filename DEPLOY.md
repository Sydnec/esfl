# Déploiement ESFL

Backend (5 micro-services + Postgres + Redis + Caddy) sur un VPS via Docker Compose,
frontend Next.js sur Vercel.

> Pour la **toute première mise en route** (création de la base, compte admin,
> ingestion automatique de l'historique), voir [docs/premier-lancement.md](docs/premier-lancement.md).

## 1. Prérequis

- Un VPS avec Docker + le plugin compose, et un nom de domaine.
- DNS : un enregistrement A `api.mondomaine.fr` → IP du VPS.
- Comptes externes :
  - **Pandascore** : token API (gratuit) → `PANDASCORE_TOKEN`
  - **Discord** : application OAuth (redirect `https://api.mondomaine.fr/auth/oauth/discord/callback`)
  - **Google** : OAuth client (redirect `https://api.mondomaine.fr/auth/oauth/google/callback`)

Les trois sources de stats (bo3.gg, VLR.gg, Leaguepedia) ne demandent aucune clé
obligatoire. Leaguepedia accepte un compte bot, qui desserre nettement son rate limit :
`LEAGUEPEDIA_USERNAME` / `LEAGUEPEDIA_BOT_PASSWORD`.

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
LEAGUEPEDIA_USERNAME=... / LEAGUEPEDIA_BOT_PASSWORD=...   # optionnel, desserre le rate limit LoL
ADMIN_TOKEN=<openssl rand -hex 32>          # token d'ops pour les routes /data/admin
```

> Chaque source est throttlée par hôte dans `polite-fetch.ts` : bo3 3-6 s variables,
> Leaguepedia 6 s, VLR 1 s. Ces valeurs sont délibérées, ne pas les baisser.

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
`PANDASCORE_TOKEN` est présent. Jobs planifiés (BullMQ) :

| Job | Fréquence | Rôle |
|---|---|---|
| `sync-series` | 12 h | Compétitions actives (toutes, pour le planning) |
| `sync-matches` | 15 min | Planning et résultats des matchs |
| `sync-rosters` | 24 h | Rosters des compétitions suivies |
| `sync-live` | 3 min | Fenêtre serrée sur les matchs imminents/en cours |
| `sync-live-stats` | 3 min | Stats live pendant les séries (Valorant, CS2) |
| `retry-stats-backfill` | 60 min | Rejoue l'ingestion des matchs finis restés sans stats |

Les stats détaillées sont ingérées à la fin de chaque match (fenêtre 48 h) avec retries en
backoff exponentiel (départ 15 min, 8 tentatives) et throttle par hôte.

Au **premier démarrage sur une base vide**, un job `backfill-history` ingère en arrière-plan tout
l'historique depuis `HISTORY_BACKFILL_SINCE` (défaut `2026-01-01`) : catalogue, matchs et stats des
matchs finis. Détails et suivi dans [docs/premier-lancement.md](docs/premier-lancement.md).

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

## État des sources de stats (2026-07-14)

Providers implémentés dans `apps/data-service/src/stats/` (un provider par jeu derrière
`provider.ts`) :

| Jeu | Source | État |
|---|---|---|
| Valorant | Scraper VLR.gg (cheerio) | ✅ validé en réel, stats live |
| CS2 | bo3.gg (API JSON publique, sans clé) | ✅ validé en réel, stats **par map** et live (K/A/D, ADR, KAST, clutchs, FK/FD, headshots) |
| LoL | Leaguepedia Cargo | ✅ implémenté (rate limit Fandom agressif, mutualisé par cache de fenêtre) |

Le rapprochement provider ↔ Pandascore (`stats/matching.ts`) s'appuie sur des alias appris
automatiquement par corrélation adverse et ajoutables à la main via la page admin. Voir
[docs/scoring-et-donnees.md](docs/scoring-et-donnees.md) pour le détail des données par source.

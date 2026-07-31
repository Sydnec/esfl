# Déploiement ESFL

Backend (5 micro-services + Postgres + Redis) sur un serveur via Docker Compose,
exposé par un tunnel Cloudflare (`cloudflared`) qui termine le TLS — pas de
reverse proxy dans le stack. Frontend Next.js sur Vercel.

> Pour la **toute première mise en route** (création de la base, compte admin,
> ingestion automatique de l'historique), voir [docs/premier-lancement.md](docs/premier-lancement.md).

## 1. Prérequis

- Un serveur avec Docker + le plugin compose.
- Un tunnel Cloudflare (`cloudflared`, service hôte) et un domaine géré par
  Cloudflare. Le tunnel route un hostname public (ex. `api.mondomaine.fr`) vers
  le gateway publié en loopback (`http://localhost:4000`). Le routage se
  configure dans le dashboard Cloudflare (tunnel token-managed) ; Cloudflare
  gère le certificat TLS — le stack n'expose donc aucun port public.
- Comptes externes :
  - **Pandascore** : token API (gratuit) → `PANDASCORE_TOKEN`
  - **Discord** : application OAuth (redirect `https://api.mondomaine.fr/auth/oauth/discord/callback`)
  - **Google** : OAuth client (redirect `https://api.mondomaine.fr/auth/oauth/google/callback`)

Les trois sources de stats (bo3.gg, VLR.gg, Leaguepedia) ne demandent aucune clé
obligatoire. Leaguepedia accepte un compte bot, qui desserre nettement son rate limit :
`LEAGUEPEDIA_USERNAME` / `LEAGUEPEDIA_BOT_PASSWORD`.

## 2. Backend sur le serveur

```bash
git clone <repo> esfl && cd esfl
cp .env.example .env.prod
```

> Le compose lit `.env` par défaut. Si la machine fait aussi tourner le dev
> (avec son propre `.env`), on isole la prod dans un `.env.prod` dédié :
> `export COMPOSE_ENV_FILES=.env.prod` une fois par session, ou préfixer chaque
> commande par `docker compose --env-file .env.prod …`. (Sur un serveur dédié à
> la prod, un simple `.env` suffit.)

Variables à renseigner dans `.env.prod` (celles utilisées par `docker-compose.yml`) :

```env
POSTGRES_PASSWORD=<fort et aléatoire>
JWT_ACCESS_SECRET=<openssl rand -hex 32>
FRONTEND_URL=https://esfl.vercel.app        # URL finale du front Vercel
OAUTH_CALLBACK_BASE_URL=https://api.mondomaine.fr   # hostname public du tunnel
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

| Job                    | Fréquence | Rôle                                                  |
| ---------------------- | --------- | ----------------------------------------------------- |
| `sync-series`          | 12 h      | Compétitions actives (toutes, pour le planning)       |
| `sync-matches`         | 15 min    | Planning et résultats des matchs                      |
| `sync-rosters`         | 24 h      | Rosters des compétitions suivies                      |
| `sync-live`            | 3 min     | Fenêtre serrée sur les matchs imminents/en cours      |
| `sync-live-stats`      | 3 min     | Stats live pendant les séries (Valorant, CS2)         |
| `retry-stats-backfill` | 60 min    | Rejoue l'ingestion des matchs finis restés sans stats |

Les stats détaillées sont ingérées à la fin de chaque match (fenêtre 48 h) avec retries en
backoff exponentiel (départ 15 min, 8 tentatives) et throttle par hôte.

Au **premier démarrage sur une base vide**, un job `backfill-history` ingère en arrière-plan tout
l'historique depuis `HISTORY_BACKFILL_SINCE` (défaut `2026-01-01`) : catalogue, matchs et stats des
matchs finis. Détails et suivi dans [docs/premier-lancement.md](docs/premier-lancement.md).

## 3. Frontend sur Vercel

1. Importer le repo dans Vercel.
2. **Root Directory** : `apps/web` (activer « Include source files outside of the
   Root Directory » — nécessaire au monorepo pnpm).
3. **Build Command** : `pnpm --filter @esfl/contracts build && next build` (c'est
   déjà le script `build` de `apps/web`, donc `pnpm run build` convient aussi).
   `@esfl/contracts` est consommé via son `dist/` (gitignoré) : sans ce build
   préalable, `next build` échoue sur « Can't resolve '@esfl/contracts' ».
4. Variable d'environnement : `NEXT_PUBLIC_API_URL=https://api.mondomaine.fr`.
5. Déployer. Reporter l'URL finale dans `FRONTEND_URL` du serveur puis
   `docker compose up -d gateway auth-service` pour recharger.

## 4. Mise à jour

```bash
git pull && docker compose up -d --build
```

## 5. Supervision des conteneurs

Chaque service expose `/health` et le compose l'interroge toutes les 30 s.
`restart: unless-stopped` ne relance qu'un process **mort** : sans sonde, un
service qui démarre mais ne répond plus — base injoignable, boucle bloquée —
resterait indéfiniment « up ». La sonde le fait basculer en `unhealthy`, visible
d'un `docker compose ps`.

`start_period: 60s` laisse le temps au `prisma migrate deploy` du démarrage.
Le gateway attend que les quatre services soient **sains** avant de démarrer,
et non seulement lancés : il ne route donc jamais vers un service qui n'a pas
fini de migrer.

```bash
docker compose ps                     # colonne STATUS : healthy / unhealthy
docker inspect --format '{{json .State.Health}}' esfl-data-service-1
```

### Alerte sur panne de source

Un parser qui casse ne lève pas d'exception : il rend zéro ligne, le job part en
retry et la couverture s'effrite en silence. Renseigner
`DISCORD_ALERT_WEBHOOK_URL` (Paramètres du salon → Intégrations → Webhooks)
déclenche un message après **10 échecs consécutifs sur une même source**.

Le seuil, et non un échec isolé, est ce qui distingue une panne du bruit normal :
quelques matchs ne sont jamais référencés par les sources, mais ils s'intercalent
entre des succès. Le moindre succès remet le compteur à zéro. Une panne qui dure
ne réalerte qu'au bout de six heures.

Sans webhook configuré, l'alerte est seulement journalisée — l'absence de
configuration ne doit jamais faire échouer une ingestion.

## 6. Sauvegarde et restauration

Le service `backup` du compose tourne en continu et écrit dans `./backups` sur
l'hôte. Deux niveaux, parce que les 97 Mo de la base ne se valent pas :

| Niveau     | Contenu                     | Rythme    | Conservation | Taille |
| ---------- | --------------------------- | --------- | ------------ | ------ |
| `critique` | schémas `auth` et `fantasy` | horaire   | 30 jours     | ~4 Ko  |
| `complet`  | toute la base               | quotidien | 7 jours      | ~18 Mo |

`data` et `scoring` se reconstruisent intégralement depuis Pandascore et les
sources de stats — quelques heures d'ingestion. **Les comptes, ligues, rosters
et picks, eux, ne se reconstruisent pas**, et pèsent 400 Ko : d'où leur rythme
horaire et leur conservation longue.

Les durées se règlent par `BACKUP_KEEP_FULL_DAYS` et `BACKUP_KEEP_CRITICAL_DAYS`.

### Restaurer

Les dumps sont produits avec `--clean --if-exists` : ils se restaurent sur une
base déjà peuplée, sans la recréer.

```bash
# Remettre uniquement les comptes et les ligues (cas le plus fréquent).
gunzip -c backups/esfl-critique-AAAAMMJJ-HHMM.sql.gz   | docker compose exec -T postgres psql -U esfl -d esfl

# Tout remettre, après une perte de volume.
gunzip -c backups/esfl-complet-AAAAMMJJ-HHMM.sql.gz   | docker compose exec -T postgres psql -U esfl -d esfl
```

Après une restauration complète, redémarrer les services pour vider les caches
mémoire et laisser BullMQ repartir : `docker compose restart`.

### Vérifier

Une sauvegarde jamais restaurée n'est pas une sauvegarde. Le test se fait sur
une base jetable, sans toucher à la production :

```bash
docker compose exec postgres psql -U esfl -d postgres -c 'CREATE DATABASE esfl_test;'
gunzip -c backups/esfl-critique-*.sql.gz | docker compose exec -T postgres psql -U esfl -d esfl_test
docker compose exec postgres psql -U esfl -d esfl_test -c 'SELECT count(*) FROM auth.users;'
docker compose exec postgres psql -U esfl -d postgres -c 'DROP DATABASE esfl_test;'
```

Un passage unique se déclenche à la main avec
`docker compose run --rm backup sh /backup.sh --once`.

## État des sources de stats (2026-07-14)

Providers implémentés dans `apps/data-service/src/stats/` (un provider par jeu derrière
`provider.ts`) :

| Jeu      | Source                               | État                                                                                       |
| -------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| Valorant | Scraper VLR.gg (cheerio)             | ✅ validé en réel, stats live                                                              |
| CS2      | bo3.gg (API JSON publique, sans clé) | ✅ validé en réel, stats **par map** et live (K/A/D, ADR, KAST, clutchs, FK/FD, headshots) |
| LoL      | Leaguepedia Cargo                    | ✅ implémenté (rate limit Fandom agressif, mutualisé par cache de fenêtre)                 |

Le rapprochement provider ↔ Pandascore (`stats/matching.ts`) s'appuie sur des alias appris
automatiquement par corrélation adverse et ajoutables à la main via la page admin. Voir
[docs/scoring-et-donnees.md](docs/scoring-et-donnees.md) pour le détail des données par source.

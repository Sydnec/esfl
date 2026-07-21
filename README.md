# ESFL — Esport Fantasy League

Fantasy league esport multigaming : **CS2, Valorant, LoL**.

Chaque journée de match, compose un roster cross-game de joueurs pros ; les joueurs pickés
sont verrouillés pendant N journées. Les points suivent leurs performances réelles.
Ligues privées entre amis, chaque ligue choisit les compétitions qu'elle suit.

## Architecture

Monorepo pnpm — micro-services NestJS (VPS, Docker) + frontend Next.js (Vercel).

| Workspace              | Rôle                                                        | Port |
| ---------------------- | ---------------------------------------------------------- | ---- |
| `apps/web`             | Frontend Next.js (App Router, CSS Modules, design minimaliste) | 3000 |
| `apps/gateway`         | API publique, validation JWT, routage vers les services    | 4000 |
| `apps/auth-service`    | Utilisateurs, OAuth Discord/Google, email+password, JWT    | 4001 |
| `apps/data-service`    | Ingestion Pandascore + stats par jeu, données de référence | 4002 |
| `apps/fantasy-service` | Ligues, compétitions suivies, rosters, locks               | 4003 |
| `apps/scoring-service` | Calcul des points fantasy, leaderboards                    | 4004 |
| `packages/contracts`   | Types, DTOs et événements partagés (zod)                   | —    |
| `packages/config`      | tsconfig partagés                                          | —    |

Infra : PostgreSQL (un schéma par service) + Redis (cache + BullMQ). Le gateway est un proxy
pur : il vérifie le JWT Bearer et le traduit en en-têtes `x-user-*` pour les services internes,
qui ne sont jamais exposés directement.

## Démarrage

```bash
cp .env.example .env        # puis remplir les secrets
pnpm install
pnpm dev:infra              # postgres (port 5433) + redis (Docker)
pnpm dev                    # build des contracts puis tous les services + le front en watch
```

- Front : http://localhost:3000
- Gateway : http://localhost:4000/health

Prisma est par service (`pnpm --filter @esfl/data-service prisma:migrate`, etc.), chaque
service ayant son propre schéma Postgres et son client généré local.

## Tests

```bash
pnpm test    # vitest dans tous les workspaces (lock fantasy, calculateurs, ingestion, providers…)
```

## Fonctionnalités notables

- **Ingestion temps réel** : synchro Pandascore planifiée, stats live pendant les séries
  (Valorant, CS2), mises à jour poussées au front en SSE (`/data/live/stream`).
- **Stats par jeu** : un provider par jeu récupère les stats détaillées à la fin de chaque
  match (retries backoff, matching équipes/joueurs, alias appris automatiquement).
- **Catalogue tier S/A/B** : seules les compétitions de tier notable (Pandascore s/a/b, ou tier
  inconnu) sont exposées ; les compétitions sans couverture de stats sont masquées.
- **Affichage arbre/poules** : les tournois à playoffs sont rendus en bracket (upper/lower pour
  la double élimination), les phases de poule en tableaux de classement calculés.
- **Administration** : page `/admin` réservée aux comptes admin — santé de l'ingestion, syncs
  forcées, relance des stats par match ou en masse, et matching manuel des équipes (alias).

## Déploiement

Voir [DEPLOY.md](DEPLOY.md) — backend Docker Compose sur VPS (Caddy TLS), frontend Vercel.
Premier lancement (création de la base, compte admin, backfill historique) :
[docs/premier-lancement.md](docs/premier-lancement.md).

## Sources de données

- **Pandascore** — planning, résultats, équipes, joueurs, tiers (free tier)
- **bo3.gg** — stats CS2 (API JSON publique, sans clé)
- **VLR.gg** (scraping, non officiel) — stats Valorant
- **Leaguepedia Cargo API** — stats LoL

Détail des barèmes et de ce que chaque source expose réellement :
[docs/scoring-et-donnees.md](docs/scoring-et-donnees.md).

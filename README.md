# ESFL — Esport Fantasy League

Fantasy league esport multigaming : **CS2, Valorant, LoL, Rocket League**.

Chaque journée de match, compose un roster cross-game de joueurs pros ; les joueurs pickés
sont verrouillés pendant N journées. Les points suivent leurs performances réelles.
Ligues privées entre amis, chaque ligue choisit les compétitions qu'elle suit.

## Architecture

Monorepo pnpm — micro-services NestJS (VPS, Docker) + frontend Next.js (Vercel).

| Workspace                | Rôle                                                        | Port |
| ------------------------ | ----------------------------------------------------------- | ---- |
| `apps/web`               | Frontend Next.js (CSS Modules, design minimaliste)          | 3000 |
| `apps/gateway`           | API publique, validation JWT, routage vers les services     | 4000 |
| `apps/auth-service`      | Utilisateurs, OAuth Discord/Google, email+password, JWT     | 4001 |
| `apps/data-service`      | Ingestion Pandascore + stats par jeu, données de référence  | 4002 |
| `apps/fantasy-service`   | Ligues, compétitions suivies, rosters, locks                | 4003 |
| `apps/scoring-service`   | Calcul des points fantasy, leaderboards                     | 4004 |
| `packages/contracts`     | Types, DTOs et événements partagés (zod)                    | —    |
| `packages/config`        | tsconfig partagés                                           | —    |

Infra : PostgreSQL (un schéma par service) + Redis (cache + BullMQ).

## Démarrage

```bash
cp .env.example .env        # puis remplir les secrets
pnpm install
pnpm dev:infra              # postgres + redis (Docker)
pnpm dev                    # tous les services + le front
```

- Front : http://localhost:3000
- Gateway : http://localhost:4000/health

## Sources de données

- **Pandascore** — planning, résultats, équipes, joueurs (free tier 1000 req/h)
- **Grid.gg Open Access** — stats CS2
- **VLR.gg** (non officiel) — stats Valorant
- **Leaguepedia Cargo API** — stats LoL
- **Octane zsr API** — stats Rocket League

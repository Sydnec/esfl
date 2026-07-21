# Premier lancement en production

Ce guide couvre la **toute première mise en route** : création de la base,
compte administrateur, et ingestion automatique de l'historique. Pour la
configuration détaillée du VPS, du domaine et des secrets, voir
[DEPLOY.md](../DEPLOY.md).

## 1. Prérequis

- VPS avec Docker + plugin compose, un domaine (`api.mondomaine.fr` → IP).
- `.env` à la racine rempli (voir [DEPLOY.md](../DEPLOY.md) pour la liste
  complète). Pour l'ingestion, au minimum :
  - `PANDASCORE_TOKEN` — **indispensable**, sinon aucune ingestion.
  - `LEAGUEPEDIA_USERNAME` / `LEAGUEPEDIA_BOT_PASSWORD` — desserrent le rate
    limit LoL (optionnels). Les stats CS2 (bo3.gg) et Valorant (VLR.gg) ne
    demandent aucune clé.
  - `ADMIN_TOKEN` — token d'ops pour les routes `/data/admin`.
  - `HISTORY_BACKFILL_SINCE` — date de début du backfill (défaut `2026-01-01`).

## 2. Création de la base de données

**Rien à faire manuellement.** Au démarrage de chaque conteneur, la commande
lancée est `prisma migrate deploy` puis `node dist/main.js` (voir `Dockerfile`).
`migrate deploy` crée le schéma du service (`auth`, `data`, `fantasy`,
`scoring`) et toutes ses tables à partir des migrations versionnées. Un seul
Postgres, un schéma par service.

```bash
git clone <repo> esfl && cd esfl
cp .env.example .env        # puis remplir les secrets
docker compose up -d --build
docker compose logs -f data-service   # suivre les migrations + le démarrage
```

Vérifier que tout répond :

```bash
curl https://api.mondomaine.fr/health
```

## 3. Backfill historique automatique (base vide)

Au premier démarrage, **si la base `data` ne contient aucune compétition**, le
data-service met en file un job `backfill-history` qui s'exécute **en arrière-
plan** :

1. liste toutes les séries (passées, en cours, à venir) dont l'activité
   chevauche `[HISTORY_BACKFILL_SINCE, maintenant]`, tous jeux confondus ;
2. upserte le catalogue (compétitions tier S/A/B) et les matchs ;
3. met en file l'ingestion des **stats de tous les matchs finis** depuis cette
   date.

Caractéristiques :

- **Déclencheur** : uniquement quand la base est vide (0 compétition). Une fois
  peuplée, un redémarrage ne relance pas le backfill.
- **Durée** : plusieurs heures selon le volume. Pandascore est throttlé à ~1
  requête / 4 s, les sources de stats (bo3, VLR, Leaguepedia) ont
  leur propre throttle, et la file BullMQ sérialise les jobs. La couverture des
  stats se remplit donc progressivement.
- **Idempotent** : upserts + `jobId` déterministe par match. Un redémarrage
  pendant le backfill (base encore vide) le relance sans créer de doublon.
- **Sans `PANDASCORE_TOKEN`** : l'ingestion est désactivée, le backfill ne part
  pas.

### Suivre l'avancement

- Logs : `docker compose logs -f data-service` (lignes « Backfill historique… »).
- Page `/admin` (compte admin requis) : santé de l'ingestion (couverture stats
  par jeu qui monte), onglet **File d'attente** (jobs en attente / en cours /
  échecs), quota Pandascore.
- En SQL :

  ```bash
  docker compose exec postgres psql -U esfl -d esfl -c \
    "SELECT game_id, count(*) FROM data.matches GROUP BY game_id;"
  ```

### Changer la date ou relancer

- Changer la fenêtre : `HISTORY_BACKFILL_SINCE=2026-03-01` dans `.env`, puis
  `docker compose up -d data-service` (avant le premier lancement, ou après
  avoir vidé la base).
- Forcer un nouveau backfill sur une base déjà peuplée : il ne part pas tout
  seul. Le plus simple est de repartir d'une base `data` vide (⚠️ destructif),
  ou d'utiliser les **synchronisations forcées** de la page `/admin` pour un
  rattrapage ciblé.

## 4. Compte administrateur

1. **S'inscrire** via l'interface (email + mot de passe, ou OAuth Discord /
   Google).
2. **Passer le compte admin** en base (colonne `is_admin` du schéma `auth`) :

   ```bash
   docker compose exec postgres psql -U esfl -d esfl -c \
     "UPDATE auth.users SET is_admin = true WHERE username = 'TonPseudo';"
   ```

3. **Se reconnecter** : la claim admin est portée par le JWT, il faut un nouveau
   login pour la rafraîchir. La page `/admin` devient alors accessible.

> Alternative sans compte : les routes `/data/admin/*` acceptent aussi le token
> d'ops `ADMIN_TOKEN` (en-tête), utile pour un script ou une sonde.

## 5. Vérifications post-lancement

- `GET /health` sur le gateway et chaque service répond `ok`.
- La page d'accueil affiche le planning des matchs (le catalogue se remplit dès
  les premières minutes du backfill).
- La page `/admin` montre la couverture des stats qui progresse.
- Créer une ligue de test, suivre une compétition, composer un roster sur une
  journée passée pour vérifier que les points remontent.

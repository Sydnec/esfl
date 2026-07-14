# Scoring fantasy & données par jeu

Référence du calcul des points fantasy (version en cours : **v4**) et des
données réellement récupérables par jeu/source. Toute modification des
barèmes doit s'accompagner d'un bump de `SCORING_VERSION`
(`apps/scoring-service/src/calculators/calculators.ts`) pour permettre un
recalcul cohérent.

## Principe commun

- Les **compteurs** (kills, buts, first kills, objectifs…) sont ramenés à une
  **moyenne par map** avant barème : `valeur / maps`. Une bonne performance
  vaut ~20-35 points quel que soit le format (Bo1/Bo3/Bo5).
- Les **taux déjà moyennés sur le match** (adr, acs, cs/min) et les **bonus de
  match** (win) **ne sont pas divisés** par le nombre de maps.
- `maps` = nombre de manches décidées (`gamesSummary` avec un vainqueur), sinon
  la somme des scores de série, sinon 1 (`mapsPlayed`).
- Chaque contribution est arrondie à 0,01 ; le total est la somme des
  contributions.

## Barèmes par jeu

La version globale (`SCORING_VERSION`) est **v4**. Le libellé `(vN)` en tête de chaque jeu
indique la dernière version où **ce** barème a changé (CS2 figé depuis v3, Valorant révisé en
v4). Un changement de barème sur n'importe quel jeu bump `SCORING_VERSION` et déclenche un
recalcul complet.

### CS2 (v3)

| Composante | Barème | Source |
| ---------- | ------ | ------ |
| kills | `(kills / maps) × 2` | Grid |
| assists | `(assists / maps) × 1` | Grid |
| deaths | `−(deaths / maps)` | Grid |
| firstKills | `(firstKills / maps) × 1,5` | Grid (firstKill par game agrégé) |
| plants | `(plants / maps) × 0,5` | Grid (objectives `plantBomb`) |
| defuses | `(defuses / maps) × 0,5` | Grid (objectives `defuseBomb`) |
| adr | `(adr ?? 0) × 0,05` | **indisponible** (toujours 0, cf. ci-dessous) |

L'ADR est conservé dans la formule mais vaut toujours 0 : Grid open-access ne
fournit aucune donnée de dégâts. v3 compense en valorisant les manches ouvertes
(firstKills) et les objectifs (plants/defuses), seules données réellement
disponibles au-delà du K/A/D.

### Valorant (v4)

| Composante | Barème | Source |
| ---------- | ------ | ------ |
| kills | `(kills / maps) × 1,5` | VLR.gg |
| assists | `(assists / maps) × 0,8` | VLR.gg |
| deaths | `−(deaths / maps)` | VLR.gg |
| acs | `(acs ?? 0) × 0,04` | VLR.gg |
| adr | `(adr ?? 0) × 0,02` | VLR.gg |
| kast | `(kast ?? 0) × 0,05` | VLR.gg |
| firstKills | `(firstKills / maps) × 1,5` | VLR.gg |
| firstDeaths | `−(firstDeaths / maps) × 0,8` | VLR.gg |

v4 exploite les données exposées par la nouvelle grille VLR : ADR (dégâts), KAST
(implication dans les rounds) et first deaths (coût des entrées ratées). L'ACS et
l'ADR étant corrélés, l'ACS reste le principal et l'ADR ajoute une part de
dégâts à poids réduit. Le **rating VLR 2.0** (composite) et le **HS%**
(mécanique) sont stockés dans `normalized`/`raw` **mais pas notés** — le rating
double-compterait toutes les autres composantes, le HS% récompenserait une
précision sans lien direct avec l'impact.

### LoL

| Composante | Barème | Source |
| ---------- | ------ | ------ |
| kills | `(kills / maps) × 3` | Leaguepedia |
| assists | `(assists / maps) × 1,5` | Leaguepedia |
| deaths | `−(deaths / maps) × 2` | Leaguepedia |
| csPerMin | `(csPerMin ?? 0) × 1` | Leaguepedia |
| win | `win ? 5 : 0` | Leaguepedia |

### Rocket League

| Composante | Barème | Source |
| ---------- | ------ | ------ |
| goals | `(goals / maps) × 8` | ballchasing.com |
| assists | `(assists / maps) × 5` | ballchasing.com |
| saves | `(saves / maps) × 4` | ballchasing.com |
| shots | `(shots / maps) × 1` | ballchasing.com |
| score | `(score ?? 0) / maps × 0,01` | ballchasing.com |

## Données récupérables par source

Le schéma normalisé par jeu est dans `packages/contracts/src/stats.ts`. Ce qui
suit détaille ce que chaque source expose **réellement** (au-delà du schéma).

### CS2 — Grid.gg (open-access, hôte `api-op.grid.gg`)

- **Disponible** : kills, deaths, assists (`killAssistsGiven`), firstKill (par
  game → agrégé en `firstKills`), objectifs (`plantBomb`, `defuseBomb`,
  `explodeBomb`), score/map par manche, `netWorth` par game.
- **Indisponible / non exploité** :
  - **ADR, rating, KAST, HS%** — aucune donnée de dégâts dans le series state
    open-access, à aucun niveau (série, game, segment).
  - **multikills** — le champ existe mais reste **toujours vide** en
    open-access.
  - **loadoutValue** — renvoie 0.
  - **netWorth** — présent mais c'est un instantané de fin de partie (signal
    faible), non normalisé ni noté.
- Pour l'ADR/rating, seule une source type HLTV (scraping fragile, Cloudflare,
  interdit par les CGU) ou une API payante (tier complet Grid, Abios/bo3.gg)
  les fournirait. Non retenu à ce stade.

### Valorant — VLR.gg (scraping cheerio)

- **Disponible** : kills, deaths, assists, ACS, ADR, KAST, HS%, rating 2.0,
  first kills, first deaths, agent + KDA/ACS par map (`perMap`). Couverture
  large (tier 1-3). Stats live pendant la série.
- Structure : grille `.ovw-table` (une par équipe), K/D/A dans une cellule
  `.ovw-cell.mod-kda`. **VLR change régulièrement son HTML** — le parser
  (`mapVlrMatchHtml`) est le point le plus fragile, à surveiller (une panne se
  traduit par « plus aucune ingestion Valorant » alors que des matchs finissent).
- Limite : le rapprochement dépend du nom d'équipe (matching manuel possible
  côté admin).

### LoL — Leaguepedia Cargo (wiki Fandom)

- **Disponible** : kills, deaths, assists, CS (→ cs/min), résultat (`win`),
  champion par game (`perMap`). Pas de map (LoL).
- Limite : rate limit Fandom agressif. La requête ramène toute la fenêtre puis
  filtre côté client — mutualisée par un cache de fenêtre (buckets de 3h) pour
  ne pas re-requêter par match. Pas de stats live (wiki rempli après coup).

### RL — ballchasing.com (`BALLCHASING_API_KEY`, token gratuit)

- **Disponible** : goals, assists, saves, shots, score in-game, buts par
  manche. Bien plus de champs (boost, déplacement, positionnement) non
  exploités.
- Limite : couverture dépendante des replays uploadés par la communauté (RLCS
  bien couvert). Filtre `pro=true`, dédup des uploads multiples d'une manche.

## Matching des équipes/joueurs

- Le rapprochement provider ↔ Pandascore est dans `stats/matching.ts`
  (`teamMatches` avec alias exacts, `matchPlayer` avec repli leet/inclusion).
- Les **alias** d'équipe sont appris automatiquement par corrélation adverse
  (Grid, ballchasing) et ajoutables manuellement via la page admin (tous les
  providers en tiennent compte).

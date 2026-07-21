# Scoring fantasy & données par jeu

Référence du calcul des points fantasy (version en cours : **v1**, notes
absolues sur une échelle commune) et des données récupérables par jeu. Toute
modification qui change les notes doit s'accompagner d'un bump de
`SCORING_VERSION` (`apps/scoring-service/src/calculators/calculators.ts`) pour
permettre un recalcul cohérent.

## Principe : rating par jeu, échelle commune

Chaque jeu produit un **rating brut** par sa propre formule, la plus fidèle
possible à la référence du jeu. Ces ratings ne sont **pas comparables entre
eux** : le rating HLTV s'étale près de deux fois plus que le rating VLR
(σ 0,357 contre 0,202). On les ramène donc sur une échelle commune avant de
convertir en note :

```
ratingCal = 1 + (ratingBrut − médiane_jeu) × (SIGMA_REF / σ_jeu)
note      = clamp(ratingCal × 50, 0, 100)
```

Repères, identiques dans les trois jeux :

| Écart à la médiane | Note |
| --- | --- |
| médiane | **50** |
| +1σ | 60 |
| +3σ | 80 |
| +5σ | **100** (exceptionnel) |

Les points fantasy sont **arrondis à l'entier**. Le score journalier d'un roster
est la **moyenne** des notes de ses picks (un pick qui n'a pas joué compte 0),
donc indépendant du nombre de picks. Le classement de ligue cumule les scores
journaliers.

L'invariant à préserver : **à percentile égal, note égale**, quel que soit le
jeu. C'est le critère d'acceptation de tout recalibrage.

## Formules par jeu

Toutes vivent dans le bloc « Formules de Rating de base (ÉDITABLES) » de
`calculators.ts` et renvoient un rating ; la conversion est centralisée.

### CS2 — HLTV 2.0 fidèle

```
impact = 2,13·KPR + 0,42·APR − 0,41
rating = 0,0073·KAST + 0,3591·KPR − 0,5329·DPR + 0,2372·impact + 0,0032·ADR + 0,1587
```

Toutes les entrées sont publiées par bo3. Le terme d'**Impact** surpondère kills
et assists : il distingue le joueur décisif de celui qui accumule en fin de
round. KAST de repli à 70 pour les fiches antérieures à la bascule par map.

### Valorant — VLR 2.0 fidèle

```
rating = 0,55·KPR + 0,23·APR + 0,0025·ADR + 0,0031·KAST − 0,87·DPR + 0,61
```

KAST et ADR imputés à la médiane quand VLR ne les publie pas.

### LoL

Formule complète si le GPM est publié, sinon secours KDA/KP — Leaguepedia n'a
le détail que pour les ligues majeures, les mineures étant saisies à la main.

Une refonte par rôle (`lolRatingV5`) est écrite et testée mais **pas encore
branchée** : elle attend ses distributions par rôle. Elle standardise chaque
métrique À L'INTÉRIEUR du rôle, ce qui neutralise le biais structurel qui
plaçait 82 supports dans le top 100.

## Bonus contextuels

Appliqués après conversion, sur la note.

| Jeu | Bonus |
| --- | --- |
| Valorant | +3 au meilleur First Kill du match, −3 au pire First Death, +2 au-delà de 2 clutchs |
| LoL | +8 Support (disparaîtra avec la standardisation par rôle) |
| CS2 | aucun |

## Recalibrer

À refaire après tout changement de formule, de source, ou une dérive de meta.
Les constantes vivent dans `calculators.ts`.

### Médiane et σ du rating par jeu → `CALIBRAGE_JEU`

Le rating brut est stocké dans le breakdown, ce qui rend la mesure directe :

```sql
SELECT game_id,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (breakdown->>'rating')::float)::numeric, 3) AS mediane,
       round(stddev_pop((breakdown->>'rating')::float)::numeric, 3) AS sigma,
       count(*) AS n
FROM scoring.fantasy_points
WHERE breakdown ? 'rating'
GROUP BY game_id;
```

### Vérifier l'alignement entre jeux

```sql
SELECT game_id, count(*) AS n,
       round(percentile_cont(0.50) WITHIN GROUP (ORDER BY points)::numeric, 1) AS mediane,
       round(percentile_cont(0.90) WITHIN GROUP (ORDER BY points)::numeric, 1) AS p90,
       round(percentile_cont(0.99) WITHIN GROUP (ORDER BY points)::numeric, 1) AS p99,
       count(*) FILTER (WHERE points = 100) AS ecretes
FROM scoring.fantasy_points GROUP BY game_id;
```

Attendu : médiane ~50 partout, p90 et p99 à quelques points près entre jeux.

### Équilibre des rôles LoL

```sql
WITH j AS (
  SELECT f.player_id, f.points, COALESCE(s.role, p.role) AS role
  FROM scoring.fantasy_points f
  JOIN data.players p ON p.id = f.player_id
  LEFT JOIN data.player_match_stats s ON s.match_id = f.match_id AND s.player_id = f.player_id
  WHERE f.game_id = 'lol'
),
agg AS (
  SELECT player_id, role, count(*) n, avg(points) moy
  FROM j GROUP BY player_id, role HAVING count(*) >= 5
)
SELECT role, count(*) AS dans_le_top_100, round(avg(moy)::numeric, 1) AS moyenne
FROM (SELECT * FROM agg ORDER BY moy DESC LIMIT 100) t
GROUP BY role ORDER BY count(*) DESC;
```

Attendu : une vingtaine de joueurs par rôle.

## Données récupérables par source

Schéma normalisé par jeu : `packages/contracts/src/stats.ts`.

| | CS2 (bo3.gg) | Valorant (VLR.gg) | LoL (Leaguepedia) |
| --- | --- | --- | --- |
| K/D/A | oui | oui | oui |
| ADR | oui | oui | sans objet |
| KAST | oui | oui | **non** |
| Rating de la source | oui (échelle maison) | oui (VLR 2.0) | non |
| First kills / deaths | oui | oui | non |
| Clutchs, multikills | oui | oui | non |
| Headshots | oui (nombre) | oui (%) | non |
| Détail par manche | oui | oui | oui (par game) |
| Parts d'équipe | sans objet | sans objet | dégâts, or, vision |
| Objectifs neutres | non (ni plants ni defuses) | plants / defuses | barons, dragons, hérauts, grubs |
| Nom civil, pays | oui | oui | partiel |
| Données à 15 min | sans objet | sans objet | **non** |
| Wards | sans objet | sans objet | **non** |

### CS2 — bo3.gg

API JSON publique, sans clé. La bonne ressource est
`GET /api/v1/games/{gameId}/players_stats` : stats **absolues par map**, KAST
compris, qui se remplissent pendant la partie. `players/stats_list` renvoie 0
joueur sur la moitié des matchs — ne pas l'utiliser.

Pièges : les bornes de date doivent être des **datetime** (`[gt]`/`[lt]`, jamais
`[gte]`/`[lte]` qui sont ignorés) ; l'embed `team1`/`team2` est inconstant, seuls
les ids numériques sont fiables ; `team_clan.team_id` est l'équipe DU MATCH,
`steam_profile.player.team_id` l'équipe actuelle ; le pseudo pro est
`player.nickname`, pas le pseudo Steam.

### Valorant — VLR.gg (scraping cheerio)

Overview + onglet Performance (multikills, clutchs, note d'économie, plants,
defuses). Stats live pendant la série. Les parsers HTML sont le point le plus
fragile à surveiller.

### LoL — Leaguepedia Cargo

`ScoreboardGames` joint à `ScoreboardPlayers`. `killParticipation`,
`damageShare`, `goldShare` et `visionShare` sont **calculés** depuis les totaux
d'équipe par game ; `objControl` vient d'une **requête séparée** sur les
objectifs neutres.

Piège majeur : la liste de champs de la requête principale est à la limite de ce
que Cargo accepte, et un champ inexistant fait échouer la requête ENTIÈRE en
`MWException` sans dire lequel. Vérifier tout ajout contre
`action=cargofields&table=ScoreboardPlayers` — c'est ainsi qu'un
`VisionWardsBoughtInGame` inventé a paralysé l'ingestion LoL sans que rien ne
le signale.

## Limites assumées

- **LoL sans phase de laning** : Cargo n'expose aucune donnée à 15 minutes. Un
  toplaner qui gagne sa voie sans convertir n'est pas distingué.
- **LoL sans KAST ni wards** : ces champs n'existent pas dans la table.
- **CS2 sans objectifs** : bo3 ne publie ni plants ni defuses par joueur.
- **Baiter vs clutcher** : adressé en CS2 et Valorant (clutchs publiés), pas en
  LoL.

## Matching des équipes et des joueurs

Règles **communes aux trois jeux**, dans `apps/data-service/src/stats/matching.ts` :
`teamMatches` (nom en flou, alias et tag en exact), `providerTeamMatches`
(+ slug), `teamMatchesExact` (strict, pour les noms canoniques Leaguepedia),
`matchPlayer` et `pseudosProches`.

Les ids provider persistants (`teams.provider_ids`, `players.provider_ids`) sont
appris depuis un match résolu et rendent la résolution indépendante du nom. Les
alias d'équipe s'apprennent par corrélation adverse et se complètent à la main
depuis `/admin`.

Un transfert crée une **seconde fiche** : l'index unique est
`(jeu, équipe, pseudo)`. La fusion `same-person` (nom civil + pseudo proche) les
réunit.

## Observabilité

Page admin `/admin` : santé de l'ingestion, file BullMQ, matching manuel des
équipes. `GET /scoring/admin/point-stats` donne la distribution des notes par
jeu — la médiane doit tomber sur 50.

# Scoring fantasy & données par jeu

Référence du calcul des points fantasy (version en cours : **v2**, système
Z-score cross-game) et des données récupérables par jeu/source. Toute
modification qui change les notes doit s'accompagner d'un bump de
`SCORING_VERSION` (`apps/scoring-service/src/calculators/calculators.ts`) pour
permettre un recalcul cohérent.

## Principe : standardisation Z-score

Le scoring compare des joueurs **entre jeux** en gommant les asymétries d'échelle.

1. **Standardisation (Z-score)** — chaque statistique brute `x` est ramenée à
   `Z(x) = (x − μ) / σ`, où μ (moyenne) et σ (écart-type) sont calculés sur la
   **population** du même jeu (tout l'historique des matchs finis).
   - **LoL** : μ/σ sont isolés **par rôle** (TOP/JUN/MID/ADC/SUP) — le game design
     rend les rôles structurellement asymétriques (un support « marque » moins
     qu'un ADC ; on le compare donc aux autres supports). Cela règle par
     construction le problème « les supports scorent moins ».
   - Les distributions sont stockées dans `stat_distributions` (schéma scoring),
     recalculées sur tout l'historique (paresseusement, TTL `SCORING_DISTRIBUTION_TTL_HOURS`,
     défaut 6 h ; et à chaque recalcul complet). Garde-fou : moins de
     `MIN_DISTRIBUTION_SAMPLE` (30) échantillons ou σ≈0 → Z=0 (note neutre).
   - Les **compteurs** (kills, buts…) sont ramenés à la **moyenne par map** avant
     standardisation (comparabilité Bo1/Bo3/Bo5) ; les **taux** déjà moyennés
     (adr, kast, csPerMin, bpm, ratios LoL) sont pris tels quels.

2. **4 piliers universels** par joueur : Impact (`I`), Létalité (`L`), Soutien
   (`S`), Constance (`C`) — chacun une combinaison de Z-scores (voir par jeu).

3. **Pondération** (`Z_total`, somme des poids = 1) — matrice **éditable**
   (`DEFAULT_WEIGHTS` + `LOL_ROLE_WEIGHTS` dans `calculators.ts`) :
   - Jeux unifiés (CS2, Valorant, RL) : `0.35·I + 0.30·L + 0.20·S + 0.15·C`.
   - LoL : pondération **par rôle** (le rôle dicte l'objectif).

4. **Note joueur 0-100** : `Score = clamp(50 + 15·Z_total, 0, 100)`.

5. **Score journalier d'un roster** : **moyenne** des notes des `N` joueurs
   pické (un pick qui n'a pas joué compte 0) → indépendant de `N`, comparable
   entre rosters. Le classement de ligue cumule les scores journaliers.

## Piliers par jeu

| Jeu | Impact (I) | Létalité (L) | Soutien (S) | Constance (C) |
|---|---|---|---|---|
| **CS2** | (Z(firstKills)+Z(objectifs))/2 | Z(kills) | Z(assists) | −Z(deaths) |
| **Valorant** | (Z(firstKills)−Z(firstDeaths)+Z(clutchs))/2 | (Z(adr)+Z(kills)+Z(multikills))/3 | (Z(assists)+Z(objectifs))/2 | (Z(kast)−Z(deaths)+Z(éco))/3 |
| **LoL** | Z(killParticipation) | (Z(damageShare)+Z(goldShare))/2 | (Z(visionScore)+Z(assists))/2 | −Z(deaths) |
| **RL** | (Z(shots)+Z(demosInflicted))/2 | (Z(goals)+Z(shooting%))/2 | (Z(saves)+Z(assists))/2 | (Z(boostBpm)+Z(bcpm)−Z(démos subies))/3 |

`objectifs` = plants + defuses (CS2 : Grid ; Valorant : onglet Performance VLR).
`clutchs` Valorant = 1v1..1v5 gagnés ; `multikills` = 2K..5K ; `éco` = note ECON VLR.

### Pondération LoL par rôle

| Rôle | I | L | S | C |
|---|---|---|---|---|
| TOP | 0.25 | 0.25 | 0.25 | 0.25 |
| JUN | 0.40 | 0.20 | 0.25 | 0.15 |
| MID | 0.30 | 0.40 | 0.10 | 0.20 |
| ADC | 0.20 | 0.50 | 0.05 | 0.25 |
| SUP | 0.30 | 0.05 | 0.50 | 0.15 |

## Limites assumées (tier gratuit)

- **CS2 appauvri** : Grid open-access ne fournit **ni dégâts, ni utilitaire, ni
  flash, ni contexte de round**. La Létalité se limite aux kills et le Soutien
  aux assists (pas d'`utility_damage` ni de `flash_duration`). CS2 = K/A/D
  normalisés + first kills + objectifs.
- **Baiter vs clutcher** : partiellement adressé en **Valorant** — l'onglet
  Performance VLR fournit les clutchs (1v1..1v5), intégrés à l'Impact : un
  clutcher se distingue désormais d'un simple survivant. CS2/LoL/RL restent sans
  contexte de round (`−Z(deaths)` et KAST récompensent la survie quelle qu'en
  soit l'utilité).

## Données récupérables par source

Schéma normalisé par jeu : `packages/contracts/src/stats.ts`.

### CS2 — Grid.gg (open-access, `api-op.grid.gg`)
- **Disponible** : kills, deaths, assists, firstKill (par game → agrégé),
  objectifs (`plantBomb`, `defuseBomb`).
- **Indisponible** : ADR/dégâts, flash/utilitaire, rating, KAST, multikills,
  clutchs — rien au-delà du K/A/D + first kills + objectifs.

### Valorant — VLR.gg (scraping cheerio)
- **Disponible (overview)** : kills, deaths, assists, ADR, KAST, HS%, rating 2.0,
  firstKills, firstDeaths, agent + KDA/ACS par map. Stats live pendant la série.
- **Onglet Performance** (`?game=all&tab=performance`, matchs finis) : multikills
  (2K..5K → `multiKills`), clutchs (1v1..1v5 → `clutches`), note d'économie
  `econRating` (ECON), plants (PL) et defuses (DE). Requête supplémentaire
  best-effort, fusionnée par pseudo (`mergePerformance`).
- Les parsers HTML (`mapVlrMatchHtml`, `parseVlrPerformance`) sont le point le
  plus fragile à surveiller.

### LoL — Leaguepedia Cargo (wiki Fandom)
- **Disponible** : kills, deaths, assists, CS (→ cs/min), champion, résultat,
  **DamageToChampions**, **VisionScore**, **Gold**. `killParticipation`,
  `damageShare` et `goldShare` (part de l'or de l'équipe) sont **calculés** via
  les totaux d'équipe par game.
- Rate limit Fandom agressif (authentifié via bot password ; cache de fenêtre).

### RL — ballchasing.com (`BALLCHASING_API_KEY`)
- **Disponible** : goals, assists, saves, shots, score, **boost.bpm**,
  **boost.bcpm** (boost consommé/min), **demo.inflicted**, **demo.taken**.
  `shootingPct` (buts/tirs) est **calculé** à l'agrégation. Couverture dépendante
  des replays uploadés (RLCS bien couvert).

## Matching des équipes/joueurs

- Rapprochement provider ↔ Pandascore dans `stats/matching.ts` (`teamMatches`
  flou + alias exacts, `matchPlayer` leet/inclusion).
- **Ids provider persistants** (`teams.provider_ids`, `players.provider_ids`)
  appris depuis un match résolu : VLR (id numérique), Leaguepedia (nom canonique)
  → résolution fiable des rosters et des lignes de stats, sans dépendre du nom.
- Alias d'équipe appris auto (corrélation adverse) + manuels (page admin).

## Observabilité

Page admin `/admin/stats` : moyennes de notes par jeu et par rôle LoL (doivent
tomber **≈ 50** — contrôle de cohérence de la standardisation), et joueurs les
mieux notés (filtrable par jeu).

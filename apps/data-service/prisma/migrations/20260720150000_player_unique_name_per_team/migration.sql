-- Unicité des fiches joueur au sein d'une équipe.
--
-- `pandascore_id` était le seul index unique, et il est NULL sur toutes les
-- fiches créées par un provider de stats — or NULL n'entre jamais en conflit
-- dans un index unique Postgres. Rien n'empêchait donc deux jobs d'ingestion
-- concurrents sur la même équipe de créer deux fois la même fiche.
--
-- Index d'EXPRESSION plutôt qu'une colonne normalisée maintenue par l'app :
-- rien à garder en phase lors d'un renommage. Même normalisation que
-- `normalizeName` (src/stats/matching.ts) : minuscules, tout caractère non
-- alphanumérique retiré — « HeavyGoD » et « HeavyGod » sont bien la même clé.
--
-- Portée volontairement limitée à (jeu, équipe) : un regroupement à l'échelle
-- du jeu écraserait de vrais homonymes évoluant dans des équipes différentes.
-- team_id NULL reste libre de doublons (NULL non conflictuel), ce qui est sans
-- effet aujourd'hui : aucune fiche n'est sans équipe.
CREATE UNIQUE INDEX "players_game_team_name_key"
  ON "players" ("game_id", "team_id", (lower(regexp_replace("name", '[^a-zA-Z0-9]', '', 'g'))));

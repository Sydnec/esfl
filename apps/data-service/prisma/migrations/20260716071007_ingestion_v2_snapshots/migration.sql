-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "team_a_snapshot" JSONB,
ADD COLUMN     "team_b_snapshot" JSONB;

-- AlterTable
ALTER TABLE "player_match_stats" ADD COLUMN     "player_name" TEXT,
ADD COLUMN     "role" TEXT,
ADD COLUMN     "team_side" TEXT;

-- AlterTable
ALTER TABLE "players" ADD COLUMN     "field_sources" JSONB;

-- AlterTable
ALTER TABLE "teams" ADD COLUMN     "field_sources" JSONB,
ADD COLUMN     "roster_synced_at" TIMESTAMP(3);

-- Backfill des snapshots pour les stats déjà ingérées : le rôle/pseudo courant
-- du joueur et le nom/tag courant des équipes sont la meilleure approximation
-- du moment T disponible (sémantique validée : migration en place).
UPDATE "player_match_stats" pms
SET "player_name" = p."name", "role" = p."role"
FROM "players" p
WHERE p."id" = pms."player_id" AND pms."player_name" IS NULL;

UPDATE "player_match_stats" pms
SET "team_side" = CASE
  WHEN p."team_id" = m."team_a_id" THEN 'A'
  WHEN p."team_id" = m."team_b_id" THEN 'B'
END
FROM "players" p, "matches" m
WHERE p."id" = pms."player_id" AND m."id" = pms."match_id" AND pms."team_side" IS NULL;

-- Snapshots équipes uniquement pour les matchs ayant déjà des stats (inutile
-- de figer les matchs futurs, l'ingestion s'en chargera). Pas de logo.
UPDATE "matches" m
SET "team_a_snapshot" = jsonb_build_object('name', t."name", 'acronym', t."acronym")
FROM "teams" t
WHERE t."id" = m."team_a_id" AND m."team_a_snapshot" IS NULL
  AND EXISTS (SELECT 1 FROM "player_match_stats" s WHERE s."match_id" = m."id");

UPDATE "matches" m
SET "team_b_snapshot" = jsonb_build_object('name', t."name", 'acronym', t."acronym")
FROM "teams" t
WHERE t."id" = m."team_b_id" AND m."team_b_snapshot" IS NULL
  AND EXISTS (SELECT 1 FROM "player_match_stats" s WHERE s."match_id" = m."id");

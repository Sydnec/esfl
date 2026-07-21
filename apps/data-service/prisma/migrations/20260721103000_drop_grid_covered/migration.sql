-- La couverture provider n'a plus lieu d'être : bo3 référence tous les tiers,
-- le pré-contrôle ne faisait que consommer le throttle utile à l'ingestion.
ALTER TABLE "matches" DROP COLUMN "grid_covered";

-- Les seriesId Grid mémorisés ne veulent rien dire pour bo3 : on les purge
-- pour que le provider re-résolve chaque match CS2 par identité d'équipe.
UPDATE "matches" SET "stats_page_url" = NULL WHERE "game_id" = 'cs2';

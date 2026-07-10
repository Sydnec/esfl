-- Les matchs CS2 finis depuis plus de 48h sans stats ne seront jamais
-- rattrapés (fenêtre d'ingestion) : on les exclut du catalogue comme les
-- matchs non couverts par Grid.
UPDATE "matches" m
SET "grid_covered" = false
WHERE m."game_id" = 'cs2'
  AND m."status" = 'finished'
  AND m."end_at" < now() - interval '48 hours'
  AND NOT EXISTS (
    SELECT 1 FROM "player_match_stats" s WHERE s."match_id" = m."id"
  );

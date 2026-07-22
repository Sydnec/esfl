-- Horodatage de la dernière tentative d'adoption : le job traite les fiches les
-- moins récemment tentées d'abord, pour ne pas réinterroger indéfiniment celles
-- que Pandascore ne connaît pas au détriment de celles jamais essayées.
ALTER TABLE "players" ADD COLUMN "adoption_tried_at" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "player_adoption_candidates" ADD CONSTRAINT "player_adoption_candidates_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

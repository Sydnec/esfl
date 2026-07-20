-- CreateTable
CREATE TABLE "player_adoption_candidates" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "candidates" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_adoption_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "player_adoption_candidates_player_id_key" ON "player_adoption_candidates"("player_id");

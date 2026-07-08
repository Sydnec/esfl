-- CreateTable
CREATE TABLE "fantasy_points" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "points" DOUBLE PRECISION NOT NULL,
    "breakdown" JSONB NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fantasy_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roster_scores" (
    "id" TEXT NOT NULL,
    "roster_id" TEXT NOT NULL,
    "league_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "match_day_date" TEXT NOT NULL,
    "points" DOUBLE PRECISION NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roster_scores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fantasy_points_player_id_idx" ON "fantasy_points"("player_id");

-- CreateIndex
CREATE UNIQUE INDEX "fantasy_points_match_id_player_id_key" ON "fantasy_points"("match_id", "player_id");

-- CreateIndex
CREATE UNIQUE INDEX "roster_scores_roster_id_key" ON "roster_scores"("roster_id");

-- CreateIndex
CREATE INDEX "roster_scores_league_id_idx" ON "roster_scores"("league_id");

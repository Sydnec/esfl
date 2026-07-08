-- CreateTable
CREATE TABLE "competitions" (
    "id" TEXT NOT NULL,
    "pandascore_id" INTEGER NOT NULL,
    "game_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "tier" TEXT,
    "begin_at" TIMESTAMP(3),
    "end_at" TIMESTAMP(3),
    "image_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "pandascore_id" INTEGER NOT NULL,
    "game_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "acronym" TEXT,
    "image_url" TEXT,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competition_teams" (
    "competition_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,

    CONSTRAINT "competition_teams_pkey" PRIMARY KEY ("competition_id","team_id")
);

-- CreateTable
CREATE TABLE "players" (
    "id" TEXT NOT NULL,
    "pandascore_id" INTEGER NOT NULL,
    "game_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "image_url" TEXT,
    "role" TEXT,
    "team_id" TEXT,

    CONSTRAINT "players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matches" (
    "id" TEXT NOT NULL,
    "pandascore_id" INTEGER NOT NULL,
    "game_id" TEXT NOT NULL,
    "competition_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "scheduled_at" TIMESTAMP(3),
    "begin_at" TIMESTAMP(3),
    "end_at" TIMESTAMP(3),
    "team_a_id" TEXT,
    "team_b_id" TEXT,
    "score_a" INTEGER,
    "score_b" INTEGER,
    "winner_team_id" TEXT,
    "finished_event_sent" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_match_stats" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "raw" JSONB NOT NULL,
    "normalized" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "player_match_stats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "competitions_pandascore_id_key" ON "competitions"("pandascore_id");

-- CreateIndex
CREATE INDEX "competitions_game_id_idx" ON "competitions"("game_id");

-- CreateIndex
CREATE UNIQUE INDEX "teams_pandascore_id_key" ON "teams"("pandascore_id");

-- CreateIndex
CREATE INDEX "teams_game_id_idx" ON "teams"("game_id");

-- CreateIndex
CREATE UNIQUE INDEX "players_pandascore_id_key" ON "players"("pandascore_id");

-- CreateIndex
CREATE INDEX "players_game_id_idx" ON "players"("game_id");

-- CreateIndex
CREATE INDEX "players_team_id_idx" ON "players"("team_id");

-- CreateIndex
CREATE UNIQUE INDEX "matches_pandascore_id_key" ON "matches"("pandascore_id");

-- CreateIndex
CREATE INDEX "matches_competition_id_idx" ON "matches"("competition_id");

-- CreateIndex
CREATE INDEX "matches_status_idx" ON "matches"("status");

-- CreateIndex
CREATE INDEX "matches_scheduled_at_idx" ON "matches"("scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "player_match_stats_match_id_player_id_key" ON "player_match_stats"("match_id", "player_id");

-- AddForeignKey
ALTER TABLE "competition_teams" ADD CONSTRAINT "competition_teams_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_teams" ADD CONSTRAINT "competition_teams_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "players" ADD CONSTRAINT "players_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_match_stats" ADD CONSTRAINT "player_match_stats_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_match_stats" ADD CONSTRAINT "player_match_stats_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

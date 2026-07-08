-- CreateTable
CREATE TABLE "leagues" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "invite_code" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "roster_size" INTEGER NOT NULL DEFAULT 5,
    "lock_match_days" INTEGER NOT NULL DEFAULT 2,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leagues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "league_members" (
    "league_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "league_members_pkey" PRIMARY KEY ("league_id","user_id")
);

-- CreateTable
CREATE TABLE "league_competitions" (
    "league_id" TEXT NOT NULL,
    "competition_id" TEXT NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "league_competitions_pkey" PRIMARY KEY ("league_id","competition_id")
);

-- CreateTable
CREATE TABLE "match_days" (
    "id" TEXT NOT NULL,
    "league_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "first_match_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "match_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rosters" (
    "id" TEXT NOT NULL,
    "league_id" TEXT NOT NULL,
    "match_day_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rosters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roster_picks" (
    "id" TEXT NOT NULL,
    "roster_id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,

    CONSTRAINT "roster_picks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "leagues_invite_code_key" ON "leagues"("invite_code");

-- CreateIndex
CREATE INDEX "league_members_user_id_idx" ON "league_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_days_league_id_date_key" ON "match_days"("league_id", "date");

-- CreateIndex
CREATE INDEX "rosters_league_id_user_id_idx" ON "rosters"("league_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "rosters_match_day_id_user_id_key" ON "rosters"("match_day_id", "user_id");

-- CreateIndex
CREATE INDEX "roster_picks_player_id_idx" ON "roster_picks"("player_id");

-- CreateIndex
CREATE UNIQUE INDEX "roster_picks_roster_id_player_id_key" ON "roster_picks"("roster_id", "player_id");

-- AddForeignKey
ALTER TABLE "league_members" ADD CONSTRAINT "league_members_league_id_fkey" FOREIGN KEY ("league_id") REFERENCES "leagues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "league_competitions" ADD CONSTRAINT "league_competitions_league_id_fkey" FOREIGN KEY ("league_id") REFERENCES "leagues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_days" ADD CONSTRAINT "match_days_league_id_fkey" FOREIGN KEY ("league_id") REFERENCES "leagues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rosters" ADD CONSTRAINT "rosters_league_id_fkey" FOREIGN KEY ("league_id") REFERENCES "leagues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rosters" ADD CONSTRAINT "rosters_match_day_id_fkey" FOREIGN KEY ("match_day_id") REFERENCES "match_days"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_picks" ADD CONSTRAINT "roster_picks_roster_id_fkey" FOREIGN KEY ("roster_id") REFERENCES "rosters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

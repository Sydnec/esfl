-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "best_of" INTEGER,
ADD COLUMN     "games_summary" JSONB,
ADD COLUMN     "stream_url" TEXT;

-- AlterTable
ALTER TABLE "players" ADD COLUMN     "nationality" TEXT;

-- AlterTable
ALTER TABLE "teams" ADD COLUMN     "location" TEXT;

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "stats_failure_kind" TEXT,
ADD COLUMN     "stats_suggestion" JSONB;

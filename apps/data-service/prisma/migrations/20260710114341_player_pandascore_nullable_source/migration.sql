-- AlterTable
ALTER TABLE "players" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'pandascore',
ALTER COLUMN "pandascore_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "players" ADD COLUMN     "pandascore_alias_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

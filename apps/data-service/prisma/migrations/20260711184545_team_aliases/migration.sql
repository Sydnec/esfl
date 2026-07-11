-- AlterTable
ALTER TABLE "teams" ADD COLUMN     "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[];

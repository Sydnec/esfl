-- CreateTable
CREATE TABLE "stat_distributions" (
    "game_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT '',
    "metric" TEXT NOT NULL,
    "mean" DOUBLE PRECISION NOT NULL,
    "stddev" DOUBLE PRECISION NOT NULL,
    "sample_size" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stat_distributions_pkey" PRIMARY KEY ("game_id","role","metric")
);

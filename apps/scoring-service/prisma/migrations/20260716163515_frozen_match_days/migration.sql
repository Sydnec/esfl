-- CreateTable
CREATE TABLE "frozen_match_days" (
    "date" TEXT NOT NULL,
    "frozen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,

    CONSTRAINT "frozen_match_days_pkey" PRIMARY KEY ("date")
);

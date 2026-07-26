-- AlterTable
ALTER TABLE "Risk" ADD COLUMN     "impact" INTEGER,
ADD COLUMN     "residual_is_override" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "residual_overridden_at" TIMESTAMP(3),
ADD COLUMN     "residual_overridden_by" TEXT,
ADD COLUMN     "residual_override_reason" TEXT,
ADD COLUMN     "residual_override_stale" BOOLEAN NOT NULL DEFAULT false;

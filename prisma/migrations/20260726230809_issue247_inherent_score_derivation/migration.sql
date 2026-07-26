-- AlterTable
ALTER TABLE "Risk" ADD COLUMN     "inherent_is_override" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "inherent_overridden_at" TIMESTAMP(3),
ADD COLUMN     "inherent_overridden_by" TEXT,
ADD COLUMN     "inherent_override_reason" TEXT,
ADD COLUMN     "inherent_override_stale" BOOLEAN NOT NULL DEFAULT false;

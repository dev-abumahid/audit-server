-- aexa-server#347: EBITDA-at-risk fields on Risk (see risk.prisma's
-- comment above these columns, and ebitda_risk.ts for the calculation).
-- AlterTable
ALTER TABLE "Risk" ADD COLUMN     "ebitda_at_risk" INTEGER,
ADD COLUMN     "ebitda_benchmark_margin" DOUBLE PRECISION,
ADD COLUMN     "ebitda_benchmark_sector" TEXT,
ADD COLUMN     "ebitda_is_override" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ebitda_overridden_at" TIMESTAMP(3),
ADD COLUMN     "ebitda_overridden_by" TEXT,
ADD COLUMN     "ebitda_override_reason" TEXT,
ADD COLUMN     "ebitda_override_stale" BOOLEAN NOT NULL DEFAULT false;

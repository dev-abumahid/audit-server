-- aexa-frontend#142: Risk.ref human-readable reference codes + RiskLink model.
--
-- This is a live production table with existing Risk rows that have no ref,
-- so `ref` cannot simply be added as NOT NULL in one step (Prisma would
-- refuse, and a hand-authored ALTER would just fail against real data). This
-- migration instead:
--   1. Adds `ref` as a nullable column.
--   2. Backfills every existing row's `ref` using the EXACT SAME generation
--      scheme as the application code (see src/app/modules/risk/risk_ref.ts's
--      RISK_CATEGORY_PREFIX_MAP / categoryPrefix), ordered by `createdAt`
--      within each (org_account_id, prefix) partition, so numbering is
--      stable and reflects real creation order.
--   3. Only THEN sets `ref` NOT NULL and adds the (org_account_id, ref)
--      unique constraint, both of which would otherwise fail against
--      not-yet-backfilled rows.
--
-- Keep this SQL's CASE mapping and fallback rule in sync with
-- risk_ref.ts's RISK_CATEGORY_PREFIX_MAP/categoryPrefix if that map ever
-- changes — this migration is a one-time snapshot of that logic for
-- existing rows; it does not run again for future inserts (those go
-- through createRiskWithGeneratedRef / computeNextRiskRef instead).

-- CreateEnum
CREATE TYPE "RiskLinkType" AS ENUM ('CAUSES', 'AMPLIFIES', 'CORRELATES');

-- AlterTable (step 1: nullable for now)
ALTER TABLE "Risk" ADD COLUMN "ref" TEXT;

-- Backfill (step 2)
WITH prefixed AS (
  SELECT
    id,
    org_account_id,
    "createdAt",
    CASE lower(trim(category))
      WHEN 'cyber' THEN 'CYB'
      WHEN 'cybersecurity' THEN 'CYB'
      WHEN 'it security' THEN 'CYB'
      WHEN 'supply chain' THEN 'SUP'
      WHEN 'financial' THEN 'FIN'
      WHEN 'finance' THEN 'FIN'
      WHEN 'operational' THEN 'OPS'
      WHEN 'regulatory' THEN 'REG'
      WHEN 'compliance' THEN 'CMP'
      WHEN 'strategic' THEN 'STR'
      WHEN 'reputational' THEN 'REP'
      WHEN 'reputation' THEN 'REP'
      WHEN 'legal' THEN 'LEG'
      WHEN 'environmental' THEN 'ENV'
      WHEN 'health and safety' THEN 'HAS'
      WHEN 'health & safety' THEN 'HAS'
      WHEN 'hr' THEN 'HR'
      WHEN 'human resources' THEN 'HR'
      WHEN 'technology' THEN 'TEC'
      WHEN 'it' THEN 'ITS'
      ELSE (
        CASE
          WHEN length(upper(regexp_replace(category, '[^a-zA-Z]', '', 'g'))) >= 2
            THEN upper(left(regexp_replace(category, '[^a-zA-Z]', '', 'g'), 3))
          ELSE 'GEN'
        END
      )
    END AS prefix
  FROM "Risk"
),
sequenced AS (
  SELECT
    id,
    prefix || '-' || LPAD(
      (ROW_NUMBER() OVER (PARTITION BY org_account_id, prefix ORDER BY "createdAt"))::text,
      3,
      '0'
    ) AS new_ref
  FROM prefixed
)
UPDATE "Risk" r
SET ref = sequenced.new_ref
FROM sequenced
WHERE r.id = sequenced.id;

-- AlterTable (step 3: now safe to enforce)
ALTER TABLE "Risk" ALTER COLUMN "ref" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Risk_org_account_id_ref_key" ON "Risk"("org_account_id", "ref");

-- CreateTable
CREATE TABLE "RiskLink" (
    "id" TEXT NOT NULL,
    "org_account_id" TEXT NOT NULL,
    "source_ref" TEXT NOT NULL,
    "target_ref" TEXT NOT NULL,
    "link_type" "RiskLinkType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RiskLink_org_account_id_idx" ON "RiskLink"("org_account_id");

-- CreateIndex
CREATE INDEX "RiskLink_org_account_id_source_ref_idx" ON "RiskLink"("org_account_id", "source_ref");

-- CreateIndex
CREATE INDEX "RiskLink_org_account_id_target_ref_idx" ON "RiskLink"("org_account_id", "target_ref");

-- AddForeignKey
ALTER TABLE "RiskLink" ADD CONSTRAINT "RiskLink_org_account_id_fkey" FOREIGN KEY ("org_account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

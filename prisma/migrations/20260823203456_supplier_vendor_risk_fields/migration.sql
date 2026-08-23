-- Vendor-risk enrichment fields for Supplier -- see supplier.prisma's
-- model comment for the "why" (aexa-frontend quality-bar-loop,
-- industry-standards axis).
CREATE TYPE "SupplierRiskTier" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE "SupplierStatus" AS ENUM ('ACTIVE', 'UNDER_REVIEW', 'INACTIVE');
CREATE TYPE "SupplierContractStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'PENDING');

ALTER TABLE "Supplier"
    ADD COLUMN "risk_tier" "SupplierRiskTier",
    ADD COLUMN "next_review_date" TIMESTAMP(3),
    ADD COLUMN "primary_contact_name" TEXT,
    ADD COLUMN "primary_contact_email" TEXT,
    ADD COLUMN "contract_status" "SupplierContractStatus",
    ADD COLUMN "status" "SupplierStatus" NOT NULL DEFAULT 'ACTIVE';

CREATE INDEX "Supplier_org_account_id_status_idx" ON "Supplier"("org_account_id", "status");
CREATE INDEX "Supplier_org_account_id_risk_tier_idx" ON "Supplier"("org_account_id", "risk_tier");

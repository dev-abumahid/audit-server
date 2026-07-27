-- AlterTable
ALTER TABLE "ComplianceObligation" ADD COLUMN     "next_review_date" TIMESTAMP(3),
ADD COLUMN     "recurrence" TEXT;

-- CreateTable
CREATE TABLE "ComplianceAttestation" (
    "id" TEXT NOT NULL,
    "org_account_id" TEXT NOT NULL,
    "obligation_id" TEXT NOT NULL,
    "attested_by" TEXT NOT NULL,
    "attested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status_at_attestation" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceAttestation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComplianceAttestation_org_account_id_idx" ON "ComplianceAttestation"("org_account_id");

-- CreateIndex
CREATE INDEX "ComplianceAttestation_obligation_id_idx" ON "ComplianceAttestation"("obligation_id");

-- AddForeignKey
ALTER TABLE "ComplianceAttestation" ADD CONSTRAINT "ComplianceAttestation_org_account_id_fkey" FOREIGN KEY ("org_account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceAttestation" ADD CONSTRAINT "ComplianceAttestation_obligation_id_fkey" FOREIGN KEY ("obligation_id") REFERENCES "ComplianceObligation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

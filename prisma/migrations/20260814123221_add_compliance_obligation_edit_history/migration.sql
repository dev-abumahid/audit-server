-- CreateTable
CREATE TABLE "ComplianceObligationEdit" (
    "id" TEXT NOT NULL,
    "org_account_id" TEXT NOT NULL,
    "obligation_id" TEXT NOT NULL,
    "edited_by" TEXT NOT NULL,
    "edited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceObligationEdit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComplianceObligationEdit_org_account_id_idx" ON "ComplianceObligationEdit"("org_account_id");

-- CreateIndex
CREATE INDEX "ComplianceObligationEdit_obligation_id_idx" ON "ComplianceObligationEdit"("obligation_id");

-- AddForeignKey
ALTER TABLE "ComplianceObligationEdit" ADD CONSTRAINT "ComplianceObligationEdit_org_account_id_fkey" FOREIGN KEY ("org_account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceObligationEdit" ADD CONSTRAINT "ComplianceObligationEdit_obligation_id_fkey" FOREIGN KEY ("obligation_id") REFERENCES "ComplianceObligation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

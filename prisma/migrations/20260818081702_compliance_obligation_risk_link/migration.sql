-- AlterTable
ALTER TABLE "ComplianceObligation" ADD COLUMN     "risk_id" TEXT;

-- CreateIndex
CREATE INDEX "ComplianceObligation_risk_id_idx" ON "ComplianceObligation"("risk_id");

-- AddForeignKey
ALTER TABLE "ComplianceObligation" ADD CONSTRAINT "ComplianceObligation_risk_id_fkey" FOREIGN KEY ("risk_id") REFERENCES "Risk"("id") ON DELETE SET NULL ON UPDATE CASCADE;

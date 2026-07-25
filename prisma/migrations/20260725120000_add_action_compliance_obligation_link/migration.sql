-- AlterTable
ALTER TABLE "Action" ADD COLUMN     "complianceObligationId" TEXT;

-- AddForeignKey
ALTER TABLE "Action" ADD CONSTRAINT "Action_complianceObligationId_fkey" FOREIGN KEY ("complianceObligationId") REFERENCES "ComplianceObligation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

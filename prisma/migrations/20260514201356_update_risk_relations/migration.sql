-- AlterTable
ALTER TABLE "Inspection" ADD COLUMN     "riskId" TEXT;

-- AlterTable
ALTER TABLE "Template" ADD COLUMN     "riskId" TEXT;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_riskId_fkey" FOREIGN KEY ("riskId") REFERENCES "Risk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Template" ADD CONSTRAINT "Template_riskId_fkey" FOREIGN KEY ("riskId") REFERENCES "Risk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

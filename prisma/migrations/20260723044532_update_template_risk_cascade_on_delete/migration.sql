-- DropForeignKey
ALTER TABLE "Template" DROP CONSTRAINT "Template_riskId_fkey";

-- AddForeignKey
ALTER TABLE "Template" ADD CONSTRAINT "Template_riskId_fkey" FOREIGN KEY ("riskId") REFERENCES "Risk"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Risk" ADD COLUMN     "supersededAt" TIMESTAMP(3),
ADD COLUMN     "supersededByRiskId" TEXT;

-- CreateIndex
CREATE INDEX "Risk_supersededByRiskId_idx" ON "Risk"("supersededByRiskId");

-- CreateIndex
CREATE INDEX "Risk_org_account_id_supersededAt_idx" ON "Risk"("org_account_id", "supersededAt");

-- AddForeignKey
ALTER TABLE "Risk" ADD CONSTRAINT "Risk_supersededByRiskId_fkey" FOREIGN KEY ("supersededByRiskId") REFERENCES "Risk"("id") ON DELETE SET NULL ON UPDATE CASCADE;

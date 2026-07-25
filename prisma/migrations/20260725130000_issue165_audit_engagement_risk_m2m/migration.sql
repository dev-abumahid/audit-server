-- AlterTable
ALTER TABLE "AuditEngagement" DROP COLUMN "linked_risk_refs";

-- CreateTable
CREATE TABLE "AuditEngagementRisk" (
    "id" TEXT NOT NULL,
    "auditEngagementId" TEXT NOT NULL,
    "riskId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEngagementRisk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditEngagementRisk_auditEngagementId_idx" ON "AuditEngagementRisk"("auditEngagementId");

-- CreateIndex
CREATE INDEX "AuditEngagementRisk_riskId_idx" ON "AuditEngagementRisk"("riskId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEngagementRisk_auditEngagementId_riskId_key" ON "AuditEngagementRisk"("auditEngagementId", "riskId");

-- AddForeignKey
ALTER TABLE "AuditEngagementRisk" ADD CONSTRAINT "AuditEngagementRisk_auditEngagementId_fkey" FOREIGN KEY ("auditEngagementId") REFERENCES "AuditEngagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEngagementRisk" ADD CONSTRAINT "AuditEngagementRisk_riskId_fkey" FOREIGN KEY ("riskId") REFERENCES "Risk"("id") ON DELETE CASCADE ON UPDATE CASCADE;


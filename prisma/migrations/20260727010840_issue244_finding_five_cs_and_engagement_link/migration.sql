-- AlterTable
ALTER TABLE "Action" ADD COLUMN     "auditEngagementId" TEXT,
ADD COLUMN     "cause" TEXT,
ADD COLUMN     "condition" TEXT,
ADD COLUMN     "criteria" TEXT,
ADD COLUMN     "effect" TEXT;

-- AddForeignKey
ALTER TABLE "Action" ADD CONSTRAINT "Action_auditEngagementId_fkey" FOREIGN KEY ("auditEngagementId") REFERENCES "AuditEngagement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrgAuditAction" ADD VALUE 'FINDING_ASSIGNMENT_CREATED';
ALTER TYPE "OrgAuditAction" ADD VALUE 'FINDING_ASSIGNMENT_APPROVED';
ALTER TYPE "OrgAuditAction" ADD VALUE 'FINDING_ASSIGNMENT_REJECTED';
ALTER TYPE "OrgAuditAction" ADD VALUE 'FINDING_ASSIGNMENT_REVOKED';
ALTER TYPE "OrgAuditAction" ADD VALUE 'ORG_SETTINGS_CHANGED';

-- AlterTable
ALTER TABLE "FindingAssignment" ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "revokedById" TEXT;

-- CreateIndex (partial unique, no Prisma DSL equivalent — see schema comment)
-- Only one *live* internal-member assignment per (actionId, orgMemberId)
-- pair; a revoked or rejected row doesn't block a fresh assignment attempt
-- for the same pair. Scoped to orgMemberId IS NOT NULL since this covers
-- slice 4 (internal LIGHT_USER members) only — external member assignments
-- (slice 5) aren't built yet.
CREATE UNIQUE INDEX "FindingAssignment_live_action_member_key"
    ON "FindingAssignment"("actionId", "orgMemberId")
    WHERE "orgMemberId" IS NOT NULL AND "revokedAt" IS NULL AND "status" != 'REJECTED';

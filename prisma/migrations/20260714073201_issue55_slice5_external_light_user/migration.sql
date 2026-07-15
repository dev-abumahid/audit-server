-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrgAuditAction" ADD VALUE 'EXTERNAL_MEMBER_INVITED';
ALTER TYPE "OrgAuditAction" ADD VALUE 'EXTERNAL_MEMBER_REMOVED';
ALTER TYPE "OrgAuditAction" ADD VALUE 'EXTERNAL_MEMBER_LOGIN_SUCCEEDED';

-- AlterTable
ALTER TABLE "OrgAuditLog" ADD COLUMN     "subjectExternalOrgMemberId" TEXT;

-- CreateIndex
CREATE INDEX "OrgAuditLog_subjectExternalOrgMemberId_idx" ON "OrgAuditLog"("subjectExternalOrgMemberId");

-- CreateIndex (partial unique, no Prisma DSL equivalent — see FindingAssignment
-- schema comment). Mirrors FindingAssignment_live_action_member_key from
-- slice 4, scoped to externalOrgMemberId instead of orgMemberId: only one
-- *live* external-member assignment per (actionId, externalOrgMemberId)
-- pair; a revoked or rejected row doesn't block a fresh assignment attempt.
CREATE UNIQUE INDEX "FindingAssignment_live_action_external_member_key"
    ON "FindingAssignment"("actionId", "externalOrgMemberId")
    WHERE "externalOrgMemberId" IS NOT NULL AND "revokedAt" IS NULL AND "status" != 'REJECTED';

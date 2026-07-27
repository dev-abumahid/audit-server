-- CreateEnum
CREATE TYPE "ActionClosureApprovalStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrgAuditAction" ADD VALUE 'ACTION_CLOSURE_SUBMITTED';
ALTER TYPE "OrgAuditAction" ADD VALUE 'ACTION_CLOSURE_APPROVED';
ALTER TYPE "OrgAuditAction" ADD VALUE 'ACTION_CLOSURE_REJECTED';
ALTER TYPE "OrgAuditAction" ADD VALUE 'ACTION_CLOSURE_INVALIDATED';

-- CreateTable
CREATE TABLE "ActionClosureApproval" (
    "id" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "status" "ActionClosureApprovalStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requestedStatus" "STATUS" NOT NULL,
    "submittedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "invalidatedAt" TIMESTAMP(3),
    "invalidatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionClosureApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActionClosureApproval_actionId_idx" ON "ActionClosureApproval"("actionId");

-- CreateIndex
CREATE INDEX "ActionClosureApproval_status_idx" ON "ActionClosureApproval"("status");

-- AddForeignKey
ALTER TABLE "ActionClosureApproval" ADD CONSTRAINT "ActionClosureApproval_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "Action"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex (partial unique, no Prisma DSL equivalent — see action.prisma comment)
-- At most one *live* closure cycle per action: a cycle is live while it's
-- still pending AND hasn't been invalidated by a later edit. A REJECTED or
-- invalidated row never blocks a fresh submission for the same action.
-- Mirrors RiskApproval_live_risk_key (aexa-frontend#95).
CREATE UNIQUE INDEX "ActionClosureApproval_live_action_key"
    ON "ActionClosureApproval"("actionId")
    WHERE "invalidatedAt" IS NULL AND "status" != 'REJECTED';

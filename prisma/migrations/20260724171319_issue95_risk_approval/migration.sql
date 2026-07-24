-- CreateEnum
CREATE TYPE "RiskApprovalStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrgAuditAction" ADD VALUE 'RISK_SUBMITTED_FOR_APPROVAL';
ALTER TYPE "OrgAuditAction" ADD VALUE 'RISK_APPROVAL_APPROVED';
ALTER TYPE "OrgAuditAction" ADD VALUE 'RISK_APPROVAL_REJECTED';
ALTER TYPE "OrgAuditAction" ADD VALUE 'RISK_APPROVAL_INVALIDATED';

-- CreateTable
CREATE TABLE "RiskApproval" (
    "id" TEXT NOT NULL,
    "riskId" TEXT NOT NULL,
    "status" "RiskApprovalStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "submittedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "invalidatedAt" TIMESTAMP(3),
    "invalidatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RiskApproval_riskId_idx" ON "RiskApproval"("riskId");

-- CreateIndex
CREATE INDEX "RiskApproval_status_idx" ON "RiskApproval"("status");

-- AddForeignKey
ALTER TABLE "RiskApproval" ADD CONSTRAINT "RiskApproval_riskId_fkey" FOREIGN KEY ("riskId") REFERENCES "Risk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex (partial unique, no Prisma DSL equivalent — see risk.prisma comment)
-- At most one *live* approval cycle per risk: a cycle is live while it's still
-- pending or approved AND hasn't been invalidated by a later edit. A REJECTED
-- or invalidated row never blocks a fresh submission for the same risk. Mirrors
-- FindingAssignment_live_action_member_key (issue #55 slice 4).
CREATE UNIQUE INDEX "RiskApproval_live_risk_key"
    ON "RiskApproval"("riskId")
    WHERE "invalidatedAt" IS NULL AND "status" != 'REJECTED';

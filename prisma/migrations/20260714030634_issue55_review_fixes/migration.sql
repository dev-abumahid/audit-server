-- CreateEnum
CREATE TYPE "MessageVisibility" AS ENUM ('INTERNAL', 'CLIENT_VISIBLE');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('ADMIN', 'LEAD_AUDITOR', 'LIGHT_USER', 'VIEWER');

-- CreateEnum
CREATE TYPE "OrgMemberStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "FindingAssignmentStatus" AS ENUM ('PENDING_APPROVAL', 'ACTIVE', 'REJECTED');

-- CreateEnum
CREATE TYPE "OrgInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "OrgAuditAction" AS ENUM ('MEMBER_INVITED', 'MEMBER_INVITE_RESENT', 'MEMBER_INVITE_ACCEPTED', 'MEMBER_STATUS_CHANGED', 'MEMBER_EXPIRY_CHANGED', 'MEMBER_REMOVED', 'INSPECTION_ASSIGNMENT_CREATED', 'INSPECTION_ASSIGNMENT_REVOKED');

-- AlterTable
ALTER TABLE "ActionMessage" ADD COLUMN     "visibility" "MessageVisibility" NOT NULL DEFAULT 'INTERNAL';

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "anchorAccountId" TEXT NOT NULL,
    "requireApprovalForSubAssignment" BOOLEAN NOT NULL DEFAULT false,
    "leadAuditorRoleLabel" TEXT NOT NULL DEFAULT 'Lead Auditor',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgMember" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL,
    "status" "OrgMemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionAssignment" (
    "id" TEXT NOT NULL,
    "orgMemberId" TEXT NOT NULL,
    "inspectionId" TEXT NOT NULL,
    "assignedById" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspectionAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FindingAssignment" (
    "id" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "orgMemberId" TEXT,
    "externalOrgMemberId" TEXT,
    "assignedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "status" "FindingAssignmentStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FindingAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgInvitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL,
    "invitedById" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "OrgInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalOrgMember" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "fullName" TEXT,
    "role" "OrgRole" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalOrgMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalOrgMemberVerificationCode" (
    "id" TEXT NOT NULL,
    "externalOrgMemberId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalOrgMemberVerificationCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgAuditLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "action" "OrgAuditAction" NOT NULL,
    "actorAccountId" TEXT,
    "subjectOrgMemberId" TEXT,
    "subjectEmail" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_anchorAccountId_key" ON "Organization"("anchorAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgMember_accountId_key" ON "OrgMember"("accountId");

-- CreateIndex
CREATE INDEX "OrgMember_organizationId_idx" ON "OrgMember"("organizationId");

-- CreateIndex
CREATE INDEX "InspectionAssignment_inspectionId_idx" ON "InspectionAssignment"("inspectionId");

-- CreateIndex
CREATE INDEX "InspectionAssignment_orgMemberId_idx" ON "InspectionAssignment"("orgMemberId");

-- CreateIndex (partial unique, no Prisma DSL equivalent — see schema comment)
-- Only one *active* assignment per member/inspection pair; a revoked one
-- doesn't block re-assigning the same member later.
CREATE UNIQUE INDEX "InspectionAssignment_active_member_inspection_key"
    ON "InspectionAssignment"("orgMemberId", "inspectionId")
    WHERE "revokedAt" IS NULL;

-- CreateIndex
CREATE INDEX "FindingAssignment_actionId_idx" ON "FindingAssignment"("actionId");

-- CreateIndex
CREATE INDEX "FindingAssignment_orgMemberId_idx" ON "FindingAssignment"("orgMemberId");

-- CreateIndex
CREATE INDEX "FindingAssignment_externalOrgMemberId_idx" ON "FindingAssignment"("externalOrgMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgInvitation_token_key" ON "OrgInvitation"("token");

-- CreateIndex
CREATE INDEX "OrgInvitation_email_idx" ON "OrgInvitation"("email");

-- CreateIndex (partial unique, no Prisma DSL equivalent)
-- Prevents the invite_member_into_db race: two concurrent requests can't
-- both create a PENDING invitation for the same (org, email) pair. An
-- ACCEPTED/EXPIRED invite for the same email doesn't block a new one.
CREATE UNIQUE INDEX "OrgInvitation_pending_org_email_key"
    ON "OrgInvitation"("organizationId", "email")
    WHERE "status" = 'PENDING';

-- CreateIndex
CREATE UNIQUE INDEX "ExternalOrgMember_organizationId_email_key" ON "ExternalOrgMember"("organizationId", "email");

-- CreateIndex
CREATE INDEX "ExternalOrgMemberVerificationCode_externalOrgMemberId_idx" ON "ExternalOrgMemberVerificationCode"("externalOrgMemberId");

-- CreateIndex
CREATE INDEX "OrgAuditLog_organizationId_createdAt_idx" ON "OrgAuditLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "OrgAuditLog_subjectOrgMemberId_idx" ON "OrgAuditLog"("subjectOrgMemberId");

-- CreateIndex
CREATE INDEX "Action_orgAccountId_idx" ON "Action"("orgAccountId");

-- CreateIndex
CREATE INDEX "Inspection_orgAccountId_idx" ON "Inspection"("orgAccountId");

-- CreateIndex
CREATE INDEX "Note_orgAccountId_idx" ON "Note"("orgAccountId");

-- CreateIndex
CREATE INDEX "Recommendation_orgAccountId_idx" ON "Recommendation"("orgAccountId");

-- CreateIndex
CREATE INDEX "Risk_org_account_id_idx" ON "Risk"("org_account_id");

-- CreateIndex
CREATE INDEX "Site_org_account_id_idx" ON "Site"("org_account_id");

-- CreateIndex
CREATE INDEX "Template_orgAccountId_idx" ON "Template"("orgAccountId");

-- AddForeignKey
ALTER TABLE "OrgMember" ADD CONSTRAINT "OrgMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgMember" ADD CONSTRAINT "OrgMember_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionAssignment" ADD CONSTRAINT "InspectionAssignment_orgMemberId_fkey" FOREIGN KEY ("orgMemberId") REFERENCES "OrgMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionAssignment" ADD CONSTRAINT "InspectionAssignment_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingAssignment" ADD CONSTRAINT "FindingAssignment_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "Action"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingAssignment" ADD CONSTRAINT "FindingAssignment_orgMemberId_fkey" FOREIGN KEY ("orgMemberId") REFERENCES "OrgMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingAssignment" ADD CONSTRAINT "FindingAssignment_externalOrgMemberId_fkey" FOREIGN KEY ("externalOrgMemberId") REFERENCES "ExternalOrgMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgInvitation" ADD CONSTRAINT "OrgInvitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalOrgMember" ADD CONSTRAINT "ExternalOrgMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalOrgMemberVerificationCode" ADD CONSTRAINT "ExternalOrgMemberVerificationCode_externalOrgMemberId_fkey" FOREIGN KEY ("externalOrgMemberId") REFERENCES "ExternalOrgMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgAuditLog" ADD CONSTRAINT "OrgAuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

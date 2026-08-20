-- CreateEnum
CREATE TYPE "RiskReviewStatus" AS ENUM ('APPROVED', 'PENDING_REVIEW', 'DISMISSED');

-- AlterTable
-- Defaults every existing row (manual risks and pre-existing AI-generated
-- risks alike) to APPROVED -- matches the prior design's contract, since AI
-- risks already wrote straight into the confirmed register before this
-- migration. See docs/design-docs/ai-risk-review-approval-workflow.md.
ALTER TABLE "Risk" ADD COLUMN "review_status" "RiskReviewStatus" NOT NULL DEFAULT 'APPROVED';

-- CreateIndex
CREATE INDEX "Risk_org_account_id_review_status_idx" ON "Risk"("org_account_id", "review_status");

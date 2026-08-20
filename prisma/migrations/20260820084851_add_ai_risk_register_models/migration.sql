-- CreateEnum
CREATE TYPE "LegalStatus" AS ENUM ('active_statutory', 'pending_statutory', 'conditional_statutory', 'recognized_standard', 'voluntary_best_practice');

-- CreateEnum
CREATE TYPE "CitationConfidence" AS ENUM ('curated_verified', 'ai_estimate', 'none');

-- CreateEnum
CREATE TYPE "AiRiskAnalysisRunStatus" AS ENUM ('running', 'completed', 'partial', 'failed');

-- AlterTable
ALTER TABLE "Risk" ADD COLUMN     "ai_generation_run_id" TEXT,
ADD COLUMN     "citation_confidence" "CitationConfidence",
ADD COLUMN     "internal_pilot" TEXT,
ADD COLUMN     "legal_status" "LegalStatus",
ADD COLUMN     "regulatory_citation_note" TEXT,
ADD COLUMN     "regulatory_framework_id" TEXT;

-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "description" TEXT;

-- CreateTable
CREATE TABLE "RegulatoryFramework" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "official_reference" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "legal_status" "LegalStatus" NOT NULL,
    "applicability_threshold" JSONB,
    "summary" TEXT NOT NULL,
    "source_url" TEXT,
    "last_verified_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegulatoryFramework_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiRiskAnalysisRun" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "org_account_id" TEXT NOT NULL,
    "triggered_by_account_id" TEXT NOT NULL,
    "status" "AiRiskAnalysisRunStatus" NOT NULL DEFAULT 'running',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "triage_result" JSONB,
    "categories_applicable" JSONB,
    "categories_skipped" JSONB,
    "categories_failed" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiRiskAnalysisRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Review finding, PR #369: prevents a re-run seed script or an admin
-- re-adding an entry from silently duplicating a curated framework -- Phase
-- 2 embeds the entire table verbatim into every generation call, so a
-- duplicate would pollute every prompt and break the byte-identical-prefix
-- requirement the prompt-caching design depends on.
CREATE UNIQUE INDEX "RegulatoryFramework_official_reference_key" ON "RegulatoryFramework"("official_reference");

-- CreateIndex
CREATE INDEX "RegulatoryFramework_legal_status_idx" ON "RegulatoryFramework"("legal_status");

-- CreateIndex
CREATE INDEX "RegulatoryFramework_domain_idx" ON "RegulatoryFramework"("domain");

-- CreateIndex
CREATE INDEX "AiRiskAnalysisRun_site_id_idx" ON "AiRiskAnalysisRun"("site_id");

-- CreateIndex
CREATE INDEX "AiRiskAnalysisRun_org_account_id_idx" ON "AiRiskAnalysisRun"("org_account_id");

-- CreateIndex
CREATE INDEX "AiRiskAnalysisRun_status_idx" ON "AiRiskAnalysisRun"("status");

-- CreateIndex
CREATE INDEX "Risk_regulatory_framework_id_idx" ON "Risk"("regulatory_framework_id");

-- CreateIndex
CREATE INDEX "Risk_ai_generation_run_id_idx" ON "Risk"("ai_generation_run_id");

-- AddForeignKey
-- Review finding, PR #369: RESTRICT not SET NULL -- citation_confidence is
-- designed as a permanent, never-drifting trust signal; a hard delete of a
-- cited RegulatoryFramework silently orphaning this FK while
-- citation_confidence stayed "curated_verified" would be exactly the drift
-- that field was designed to prevent. Forces an explicit reassignment flow
-- at the application layer before a cited framework can be removed.
ALTER TABLE "Risk" ADD CONSTRAINT "Risk_regulatory_framework_id_fkey" FOREIGN KEY ("regulatory_framework_id") REFERENCES "RegulatoryFramework"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Risk" ADD CONSTRAINT "Risk_ai_generation_run_id_fkey" FOREIGN KEY ("ai_generation_run_id") REFERENCES "AiRiskAnalysisRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRiskAnalysisRun" ADD CONSTRAINT "AiRiskAnalysisRun_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRiskAnalysisRun" ADD CONSTRAINT "AiRiskAnalysisRun_org_account_id_fkey" FOREIGN KEY ("org_account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

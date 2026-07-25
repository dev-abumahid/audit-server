-- CreateEnum
CREATE TYPE "RunType" AS ENUM ('PREDICT', 'MITIGATIONS', 'RCSA', 'RESILIENCE_SCAN');

-- CreateTable
CREATE TABLE "IntelligenceItem" (
    "id" TEXT NOT NULL,
    "org_account_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "link" TEXT,
    "source_name" TEXT NOT NULL,
    "source_category" TEXT,
    "source_credibility" DOUBLE PRECISION,
    "source_language" TEXT,
    "published_at" TIMESTAMP(3),
    "scraped_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_risk" BOOLEAN,
    "severity" TEXT,
    "category" TEXT,
    "relevance_score" DOUBLE PRECISION,
    "risk_summary" TEXT,
    "root_cause" TEXT,
    "potential_impact" TEXT,
    "recommended_actions" JSONB,
    "confidence" DOUBLE PRECISION,
    "source_evidence" TEXT,
    "analyzed_at" TIMESTAMP(3),
    "created_risk_id" TEXT,

    CONSTRAINT "IntelligenceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntelligenceRun" (
    "id" TEXT NOT NULL,
    "org_account_id" TEXT NOT NULL,
    "run_type" "RunType" NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntelligenceRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntelligenceItem_org_account_id_idx" ON "IntelligenceItem"("org_account_id");

-- CreateIndex
CREATE INDEX "IntelligenceItem_created_risk_id_idx" ON "IntelligenceItem"("created_risk_id");

-- CreateIndex
CREATE INDEX "IntelligenceRun_org_account_id_idx" ON "IntelligenceRun"("org_account_id");

-- CreateIndex
CREATE INDEX "IntelligenceRun_run_type_idx" ON "IntelligenceRun"("run_type");

-- AddForeignKey
ALTER TABLE "IntelligenceItem" ADD CONSTRAINT "IntelligenceItem_org_account_id_fkey" FOREIGN KEY ("org_account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntelligenceItem" ADD CONSTRAINT "IntelligenceItem_created_risk_id_fkey" FOREIGN KEY ("created_risk_id") REFERENCES "Risk"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntelligenceRun" ADD CONSTRAINT "IntelligenceRun_org_account_id_fkey" FOREIGN KEY ("org_account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

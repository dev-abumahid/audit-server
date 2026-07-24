-- CreateTable
CREATE TABLE "AuditEngagement" (
    "id" TEXT NOT NULL,
    "org_account_id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scope" TEXT,
    "status" TEXT NOT NULL,
    "lead_auditor" TEXT,
    "priority_score" INTEGER,
    "findings_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "ai_generated" BOOLEAN NOT NULL DEFAULT false,
    "is_edited" BOOLEAN NOT NULL DEFAULT false,
    "linked_risk_refs" TEXT[],
    "report_url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditEngagement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditEngagement_org_account_id_idx" ON "AuditEngagement"("org_account_id");

-- AddForeignKey
ALTER TABLE "AuditEngagement" ADD CONSTRAINT "AuditEngagement_org_account_id_fkey" FOREIGN KEY ("org_account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

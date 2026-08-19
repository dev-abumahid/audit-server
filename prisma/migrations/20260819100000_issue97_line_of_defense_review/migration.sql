-- CreateTable
CREATE TABLE "RiskLineReview" (
    "id" TEXT NOT NULL,
    "riskId" TEXT NOT NULL,
    "line" "LineOfDefense" NOT NULL,
    "reviewedById" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskLineReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionLineReview" (
    "id" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "line" "LineOfDefense" NOT NULL,
    "reviewedById" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionLineReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KriLineReview" (
    "id" TEXT NOT NULL,
    "kriId" TEXT NOT NULL,
    "line" "LineOfDefense" NOT NULL,
    "reviewedById" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KriLineReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceObligationLineReview" (
    "id" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "line" "LineOfDefense" NOT NULL,
    "reviewedById" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceObligationLineReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEngagementLineReview" (
    "id" TEXT NOT NULL,
    "auditEngagementId" TEXT NOT NULL,
    "line" "LineOfDefense" NOT NULL,
    "reviewedById" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditEngagementLineReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RiskLineReview_riskId_idx" ON "RiskLineReview"("riskId");
CREATE INDEX "RiskLineReview_line_idx" ON "RiskLineReview"("line");

CREATE INDEX "ActionLineReview_actionId_idx" ON "ActionLineReview"("actionId");
CREATE INDEX "ActionLineReview_line_idx" ON "ActionLineReview"("line");

CREATE INDEX "KriLineReview_kriId_idx" ON "KriLineReview"("kriId");
CREATE INDEX "KriLineReview_line_idx" ON "KriLineReview"("line");

CREATE INDEX "ComplianceObligationLineReview_obligationId_idx" ON "ComplianceObligationLineReview"("obligationId");
CREATE INDEX "ComplianceObligationLineReview_line_idx" ON "ComplianceObligationLineReview"("line");

CREATE INDEX "AuditEngagementLineReview_auditEngagementId_idx" ON "AuditEngagementLineReview"("auditEngagementId");
CREATE INDEX "AuditEngagementLineReview_line_idx" ON "AuditEngagementLineReview"("line");

-- AddForeignKey
ALTER TABLE "RiskLineReview" ADD CONSTRAINT "RiskLineReview_riskId_fkey" FOREIGN KEY ("riskId") REFERENCES "Risk"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActionLineReview" ADD CONSTRAINT "ActionLineReview_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "Action"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KriLineReview" ADD CONSTRAINT "KriLineReview_kriId_fkey" FOREIGN KEY ("kriId") REFERENCES "Kri"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComplianceObligationLineReview" ADD CONSTRAINT "ComplianceObligationLineReview_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "ComplianceObligation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditEngagementLineReview" ADD CONSTRAINT "AuditEngagementLineReview_auditEngagementId_fkey" FOREIGN KEY ("auditEngagementId") REFERENCES "AuditEngagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex (partial unique, no Prisma DSL equivalent -- see
-- line_of_defense_review.prisma's file comment)
-- At most one *live* review per (item, line): a review is live while it
-- hasn't been invalidated by a later edit to the item. An invalidated row
-- never blocks a fresh review for the same line. Mirrors
-- RiskApproval_live_risk_key's shape, keyed by line instead of by cycle.
CREATE UNIQUE INDEX "RiskLineReview_live_line_key"
    ON "RiskLineReview"("riskId", "line")
    WHERE "invalidatedAt" IS NULL;

CREATE UNIQUE INDEX "ActionLineReview_live_line_key"
    ON "ActionLineReview"("actionId", "line")
    WHERE "invalidatedAt" IS NULL;

CREATE UNIQUE INDEX "KriLineReview_live_line_key"
    ON "KriLineReview"("kriId", "line")
    WHERE "invalidatedAt" IS NULL;

CREATE UNIQUE INDEX "ComplianceObligationLineReview_live_line_key"
    ON "ComplianceObligationLineReview"("obligationId", "line")
    WHERE "invalidatedAt" IS NULL;

CREATE UNIQUE INDEX "AuditEngagementLineReview_live_line_key"
    ON "AuditEngagementLineReview"("auditEngagementId", "line")
    WHERE "invalidatedAt" IS NULL;

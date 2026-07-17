-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "org_account_id" TEXT NOT NULL,
    "kri_id" TEXT,
    "source" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "ai_generated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Kri" (
    "id" TEXT NOT NULL,
    "org_account_id" TEXT NOT NULL,
    "risk_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "current_value" DOUBLE PRECISION NOT NULL,
    "alert_threshold" DOUBLE PRECISION NOT NULL,
    "target_value" DOUBLE PRECISION NOT NULL,
    "frequency" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Kri_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Alert_org_account_id_idx" ON "Alert"("org_account_id");

-- CreateIndex
CREATE INDEX "Alert_kri_id_idx" ON "Alert"("kri_id");

-- CreateIndex
CREATE INDEX "Kri_org_account_id_idx" ON "Kri"("org_account_id");

-- CreateIndex
CREATE INDEX "Kri_risk_id_idx" ON "Kri"("risk_id");

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_org_account_id_fkey" FOREIGN KEY ("org_account_id") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_kri_id_fkey" FOREIGN KEY ("kri_id") REFERENCES "Kri"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Kri" ADD CONSTRAINT "Kri_org_account_id_fkey" FOREIGN KEY ("org_account_id") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Kri" ADD CONSTRAINT "Kri_risk_id_fkey" FOREIGN KEY ("risk_id") REFERENCES "Risk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

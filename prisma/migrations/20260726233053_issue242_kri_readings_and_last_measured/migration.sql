-- AlterTable
ALTER TABLE "Kri" ADD COLUMN     "last_measured_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "KriReading" (
    "id" TEXT NOT NULL,
    "org_account_id" TEXT NOT NULL,
    "kri_id" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KriReading_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KriReading_org_account_id_idx" ON "KriReading"("org_account_id");

-- CreateIndex
CREATE INDEX "KriReading_kri_id_idx" ON "KriReading"("kri_id");

-- CreateIndex
CREATE INDEX "KriReading_kri_id_recorded_at_idx" ON "KriReading"("kri_id", "recorded_at");

-- AddForeignKey
ALTER TABLE "KriReading" ADD CONSTRAINT "KriReading_org_account_id_fkey" FOREIGN KEY ("org_account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KriReading" ADD CONSTRAINT "KriReading_kri_id_fkey" FOREIGN KEY ("kri_id") REFERENCES "Kri"("id") ON DELETE CASCADE ON UPDATE CASCADE;

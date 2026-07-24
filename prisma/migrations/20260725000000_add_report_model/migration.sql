-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('BOARD');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('GENERATING', 'READY', 'PUBLISHED', 'FAILED');

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "org_account_id" TEXT NOT NULL,
    "type" "ReportType" NOT NULL DEFAULT 'BOARD',
    "title" TEXT NOT NULL,
    "reference" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'GENERATING',
    "content" JSONB,
    "file_url" TEXT,
    "pages" INTEGER,
    "parameters" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "generated_by" TEXT NOT NULL,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "ai_generated" BOOLEAN NOT NULL DEFAULT true,
    "error_message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Report_org_account_id_idx" ON "Report"("org_account_id");

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_org_account_id_fkey" FOREIGN KEY ("org_account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

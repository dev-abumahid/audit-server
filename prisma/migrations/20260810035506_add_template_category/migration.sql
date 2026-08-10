-- AlterTable
ALTER TABLE "Template" ADD COLUMN     "category" TEXT;

-- CreateIndex
CREATE INDEX "Template_orgAccountId_category_idx" ON "Template"("orgAccountId", "category");

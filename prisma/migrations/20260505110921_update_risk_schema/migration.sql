/*
  Warnings:

  - Added the required column `category` to the `Risk` table without a default value. This is not possible if the table is not empty.
  - Added the required column `name` to the `Risk` table without a default value. This is not possible if the table is not empty.
  - Added the required column `org_account_id` to the `Risk` table without a default value. This is not possible if the table is not empty.
  - Added the required column `site_id` to the `Risk` table without a default value. This is not possible if the table is not empty.
  - Added the required column `status` to the `Risk` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Risk" ADD COLUMN     "ai_generated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "category" TEXT NOT NULL,
ADD COLUMN     "control_design_eff" INTEGER,
ADD COLUMN     "control_operating_eff" INTEGER,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "financial_impact_max" INTEGER,
ADD COLUMN     "financial_impact_min" INTEGER,
ADD COLUMN     "inherent_score" INTEGER,
ADD COLUMN     "is_edited" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "name" TEXT NOT NULL,
ADD COLUMN     "org_account_id" TEXT NOT NULL,
ADD COLUMN     "pagerank_score" INTEGER,
ADD COLUMN     "probability" INTEGER,
ADD COLUMN     "residual_score" INTEGER,
ADD COLUMN     "site_id" TEXT NOT NULL,
ADD COLUMN     "source_info" TEXT,
ADD COLUMN     "status" TEXT NOT NULL,
ADD COLUMN     "trend" TEXT,
ADD COLUMN     "velocity" TEXT;

-- AddForeignKey
ALTER TABLE "Risk" ADD CONSTRAINT "Risk_org_account_id_fkey" FOREIGN KEY ("org_account_id") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Risk" ADD CONSTRAINT "Risk_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

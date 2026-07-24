-- AlterTable
ALTER TABLE "Kri" ADD COLUMN     "ai_generated" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "OrganizationProfile" ADD COLUMN     "country" TEXT,
ADD COLUMN     "sector" TEXT;

-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "ai_generated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "source_info" TEXT;

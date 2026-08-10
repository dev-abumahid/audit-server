-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- AlterTable
ALTER TABLE "Template" ADD COLUMN     "status" "TemplateStatus" NOT NULL DEFAULT 'PUBLISHED';

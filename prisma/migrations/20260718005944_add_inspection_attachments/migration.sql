-- AlterTable
ALTER TABLE "Inspection" ADD COLUMN     "attachments" TEXT[] DEFAULT ARRAY[]::TEXT[];

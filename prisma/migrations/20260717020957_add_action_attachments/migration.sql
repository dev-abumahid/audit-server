-- AlterTable
ALTER TABLE "Action" ADD COLUMN     "attachments" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Note" ADD COLUMN     "attachments" TEXT[] DEFAULT ARRAY[]::TEXT[];

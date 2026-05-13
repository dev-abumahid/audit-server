-- CreateEnum
CREATE TYPE "Status" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'DRAFT');

-- AlterTable
ALTER TABLE "Inspection" ADD COLUMN     "status" "Status" NOT NULL DEFAULT 'IN_PROGRESS';

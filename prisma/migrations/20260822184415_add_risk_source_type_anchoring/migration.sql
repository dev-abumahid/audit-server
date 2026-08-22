-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('anchored', 'estimated');

-- AlterTable
ALTER TABLE "Risk" ADD COLUMN     "source_reference" TEXT,
ADD COLUMN     "source_type" "SourceType" NOT NULL DEFAULT 'estimated',
ADD COLUMN     "sous_type" TEXT;


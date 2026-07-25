-- CreateEnum
CREATE TYPE "LineOfDefense" AS ENUM ('FIRST', 'SECOND', 'THIRD');

-- AlterTable
ALTER TABLE "Action" ADD COLUMN     "line_of_defense" "LineOfDefense";

-- AlterTable
ALTER TABLE "AuditEngagement" ADD COLUMN     "line_of_defense" "LineOfDefense" NOT NULL DEFAULT 'THIRD';

-- AlterTable
ALTER TABLE "ComplianceObligation" ADD COLUMN     "line_of_defense" "LineOfDefense" NOT NULL DEFAULT 'SECOND';

-- AlterTable
ALTER TABLE "Kri" ADD COLUMN     "line_of_defense" "LineOfDefense" NOT NULL DEFAULT 'SECOND';

-- AlterTable
ALTER TABLE "Risk" ADD COLUMN     "line_of_defense" "LineOfDefense" NOT NULL DEFAULT 'FIRST';

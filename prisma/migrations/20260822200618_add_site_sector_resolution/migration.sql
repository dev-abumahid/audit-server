-- CreateEnum
CREATE TYPE "SectorCodeType" AS ENUM ('SIC', 'NAF', 'ESTIMATED');

-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "secteur_code" TEXT,
ADD COLUMN     "secteur_code_type" "SectorCodeType",
ADD COLUMN     "secteur_estime" BOOLEAN NOT NULL DEFAULT false;


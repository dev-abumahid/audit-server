-- DropForeignKey
ALTER TABLE "Note" DROP CONSTRAINT "Note_inspectionId_fkey";

-- DropForeignKey
ALTER TABLE "Note" DROP CONSTRAINT "Note_orgAccountId_fkey";

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_orgAccountId_fkey" FOREIGN KEY ("orgAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DropForeignKey
ALTER TABLE "Inspection" DROP CONSTRAINT "Inspection_inspectorProfileId_fkey";

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_inspectorProfileId_fkey" FOREIGN KEY ("inspectorProfileId") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

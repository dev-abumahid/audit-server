-- DropForeignKey
ALTER TABLE "Risk" DROP CONSTRAINT "Risk_site_id_fkey";

-- AddForeignKey
ALTER TABLE "Risk" ADD CONSTRAINT "Risk_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

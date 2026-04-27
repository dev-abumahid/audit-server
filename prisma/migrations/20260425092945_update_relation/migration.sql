/*
  Warnings:

  - You are about to drop the column `userName` on the `TemplateAccess` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "TemplateAccess" DROP COLUMN "userName";

-- AddForeignKey
ALTER TABLE "TemplateAccess" ADD CONSTRAINT "TemplateAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

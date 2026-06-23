/*
  Warnings:

  - Added the required column `actionId` to the `ActionMessage` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "ActionMessage" DROP CONSTRAINT "ActionMessage_id_fkey";

-- AlterTable
ALTER TABLE "Action" ALTER COLUMN "questionId" DROP NOT NULL,
ALTER COLUMN "siteId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ActionMessage" ADD COLUMN     "actionId" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "ActionMessage" ADD CONSTRAINT "ActionMessage_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "Action"("id") ON DELETE CASCADE ON UPDATE CASCADE;

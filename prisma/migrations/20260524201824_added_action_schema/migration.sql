/*
  Warnings:

  - Added the required column `actionDisc` to the `Action` table without a default value. This is not possible if the table is not empty.
  - Added the required column `actionTitle` to the `Action` table without a default value. This is not possible if the table is not empty.
  - Added the required column `dueDate` to the `Action` table without a default value. This is not possible if the table is not empty.
  - Added the required column `inspectionId` to the `Action` table without a default value. This is not possible if the table is not empty.
  - Added the required column `orgAccountId` to the `Action` table without a default value. This is not possible if the table is not empty.
  - Added the required column `priority` to the `Action` table without a default value. This is not possible if the table is not empty.
  - Added the required column `questionId` to the `Action` table without a default value. This is not possible if the table is not empty.
  - Added the required column `siteId` to the `Action` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "PRIORITY" AS ENUM ('Low', 'Medium', 'High');

-- CreateEnum
CREATE TYPE "STATUS" AS ENUM ('TO_DO', 'IN_PROGRESS', 'COMPLETE', 'CANT_DO');

-- AlterTable
ALTER TABLE "Action" ADD COLUMN     "actionDisc" TEXT NOT NULL,
ADD COLUMN     "actionTitle" TEXT NOT NULL,
ADD COLUMN     "dueDate" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "inspectionId" TEXT NOT NULL,
ADD COLUMN     "orgAccountId" TEXT NOT NULL,
ADD COLUMN     "priority" "PRIORITY" NOT NULL,
ADD COLUMN     "questionId" TEXT NOT NULL,
ADD COLUMN     "siteId" TEXT NOT NULL,
ADD COLUMN     "status" "STATUS" NOT NULL DEFAULT 'TO_DO';

-- CreateTable
CREATE TABLE "ActionMessage" (
    "id" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "senderAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionMessage_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ActionMessage" ADD CONSTRAINT "ActionMessage_id_fkey" FOREIGN KEY ("id") REFERENCES "Action"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionMessage" ADD CONSTRAINT "ActionMessage_senderAccountId_fkey" FOREIGN KEY ("senderAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

/*
  Warnings:

  - You are about to drop the column `config` on the `Question` table. All the data in the column will be lost.
  - Added the required column `value` to the `Question` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Question" DROP COLUMN "config",
ADD COLUMN     "value" JSONB NOT NULL;

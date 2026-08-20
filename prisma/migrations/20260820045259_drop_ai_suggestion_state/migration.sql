
-- DropForeignKey
ALTER TABLE "AiSuggestionState" DROP CONSTRAINT "AiSuggestionState_orgAccountId_fkey";

-- DropForeignKey
ALTER TABLE "AiSuggestionState" DROP CONSTRAINT "AiSuggestionState_siteId_fkey";

-- DropTable
DROP TABLE "AiSuggestionState";

-- DropEnum
DROP TYPE "AiSuggestionStatus";


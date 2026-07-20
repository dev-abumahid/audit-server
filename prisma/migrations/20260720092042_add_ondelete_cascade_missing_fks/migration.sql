-- Add missing onDelete: Cascade behavior on Account/Template/Profile foreign
-- keys, matching the pattern already used by sibling relations in each
-- schema file (Closes #118, #123, #124, and two more instances of the same
-- oversight found on Alert.account and Kri.account during review).

-- DropForeignKey
ALTER TABLE "PineconeDocument" DROP CONSTRAINT "PineconeDocument_orgAccountId_fkey";

-- DropForeignKey
ALTER TABLE "Risk" DROP CONSTRAINT "Risk_org_account_id_fkey";

-- DropForeignKey
ALTER TABLE "Site" DROP CONSTRAINT "Site_org_account_id_fkey";

-- DropForeignKey
ALTER TABLE "TemplateAccess" DROP CONSTRAINT "TemplateAccess_userId_fkey";

-- DropForeignKey
ALTER TABLE "Alert" DROP CONSTRAINT "Alert_org_account_id_fkey";

-- DropForeignKey
ALTER TABLE "Kri" DROP CONSTRAINT "Kri_org_account_id_fkey";

-- AddForeignKey
ALTER TABLE "PineconeDocument" ADD CONSTRAINT "PineconeDocument_orgAccountId_fkey" FOREIGN KEY ("orgAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Risk" ADD CONSTRAINT "Risk_org_account_id_fkey" FOREIGN KEY ("org_account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_org_account_id_fkey" FOREIGN KEY ("org_account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateAccess" ADD CONSTRAINT "TemplateAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_org_account_id_fkey" FOREIGN KEY ("org_account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Kri" ADD CONSTRAINT "Kri_org_account_id_fkey" FOREIGN KEY ("org_account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

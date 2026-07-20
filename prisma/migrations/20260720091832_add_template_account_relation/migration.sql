-- AddForeignKey
ALTER TABLE "Template" ADD CONSTRAINT "Template_orgAccountId_fkey" FOREIGN KEY ("orgAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

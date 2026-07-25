-- CreateIndex
CREATE UNIQUE INDEX "RiskLink_org_account_id_source_ref_target_ref_link_type_key" ON "RiskLink"("org_account_id", "source_ref", "target_ref", "link_type");


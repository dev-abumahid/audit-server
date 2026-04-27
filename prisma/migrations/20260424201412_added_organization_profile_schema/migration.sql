-- CreateTable
CREATE TABLE "OrganizationProfile" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "organizationName" TEXT NOT NULL,
    "organizationLogo" TEXT,
    "organizationLocation" TEXT,
    "organizationDescription" TEXT,
    "organizationWebsite" TEXT,
    "organizationPhone" TEXT,

    CONSTRAINT "OrganizationProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationProfile_accountId_key" ON "OrganizationProfile"("accountId");

-- AddForeignKey
ALTER TABLE "OrganizationProfile" ADD CONSTRAINT "OrganizationProfile_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

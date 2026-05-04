-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "org_account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT,
    "country" TEXT,
    "activity" TEXT,
    "revenue" INTEGER NOT NULL,
    "employees_count" INTEGER NOT NULL,
    "site_type" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_org_account_id_fkey" FOREIGN KEY ("org_account_id") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

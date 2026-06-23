-- CreateTable
CREATE TABLE "PineconeDocument" (
    "id" TEXT NOT NULL,
    "fileName" TEXT,
    "fileId" TEXT,
    "orgAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PineconeDocument_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "PineconeDocument" ADD CONSTRAINT "PineconeDocument_orgAccountId_fkey" FOREIGN KEY ("orgAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ActionResponsible" (
    "id" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "orgMemberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionResponsible_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActionResponsible_orgMemberId_idx" ON "ActionResponsible"("orgMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "ActionResponsible_actionId_orgMemberId_key" ON "ActionResponsible"("actionId", "orgMemberId");

-- AddForeignKey
ALTER TABLE "ActionResponsible" ADD CONSTRAINT "ActionResponsible_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "Action"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionResponsible" ADD CONSTRAINT "ActionResponsible_orgMemberId_fkey" FOREIGN KEY ("orgMemberId") REFERENCES "OrgMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

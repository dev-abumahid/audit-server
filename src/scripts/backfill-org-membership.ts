/**
 * One-time (but idempotent) backfill for issue #55 slice 1.
 *
 * For every existing Account that does not already have an OrgMember row,
 * creates:
 *   1. An Organization anchored to that account (`anchorAccountId`), named
 *      after the account's OrganizationProfile.organizationName if present,
 *      falling back to the account's email.
 *   2. An OrgMember row linking the account to that Organization as ADMIN /
 *      ACTIVE — this preserves today's behavior, where every account is
 *      effectively the sole admin of its own org-scoped data.
 *
 * Safe to re-run: accounts that already have an OrgMember row (checked via
 * the unique `OrgMember.accountId` constraint) are skipped. Each account's
 * pair of inserts (Organization + OrgMember) is wrapped in a single
 * `prisma.$transaction` call so it's all-or-nothing per account — a failure
 * partway through never leaves an Organization without its OrgMember, or
 * vice versa.
 *
 * Run with:
 *   npm run backfill:org-membership
 */
import { fileURLToPath } from 'node:url';
import { prisma } from '../app/lib/prisma.js';

export async function backfillOrgMembership() {
  const accounts = await prisma.account.findMany({
    include: {
      organizationProfile: true,
      orgMembership: true,
    },
  });

  let processed = 0;
  let skipped = 0;

  for (const account of accounts) {
    if (account.orgMembership) {
      skipped += 1;
      continue;
    }

    const orgName = account.organizationProfile?.organizationName || account.email;

    await prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          name: orgName,
          anchorAccountId: account.id,
        },
      });

      await tx.orgMember.create({
        data: {
          organizationId: organization.id,
          accountId: account.id,
          role: 'ADMIN',
          status: 'ACTIVE',
        },
      });
    });

    processed += 1;
  }

  console.log(
    `[backfill-org-membership] done. accounts processed: ${processed}, accounts skipped (already migrated): ${skipped}, total accounts: ${accounts.length}`,
  );
}

// Only auto-run when executed directly (`npm run backfill:org-membership`),
// not when imported (e.g. by tests).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  backfillOrgMembership()
    .catch((err) => {
      console.error('[backfill-org-membership] failed:', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

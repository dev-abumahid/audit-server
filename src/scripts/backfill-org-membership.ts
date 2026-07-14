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
 * Per-account failures (including a real concurrent-signup race — a new
 * account.service.ts signup now creates its own OrgMember row, so it's
 * possible for one to appear between this script's initial findMany
 * snapshot and that account's turn in the loop below) are caught and
 * logged rather than aborting the whole run: this is a one-time migration
 * over what could be a large accounts table, and one bad/racing row
 * shouldn't block every account after it in iteration order. Found by
 * independent review — the original version had no per-account try/catch,
 * so a single P2002 crashed the entire script.
 *
 * Run with:
 *   npm run backfill:org-membership
 */
import { Prisma } from '@prisma/client';
import { fileURLToPath } from 'node:url';
import { prisma } from '../app/lib/prisma.js';

// Page size for the account scan (see the pagination note below) and the
// number of per-account transactions allowed in flight at once. Neither is
// tuned to anything specific — both just need to be well above what any
// existing test fixture returns (so pagination naturally terminates after
// one page in tests) and comfortably below "overwhelm the DB connection
// pool" for a real run.
const PAGE_SIZE = 500;
const CONCURRENCY = 10;

/**
 * Runs `fn` over `items` with at most `limit` in flight at once, instead of
 * either fully serial (one $transaction at a time — slow on a large table,
 * each paying its own round-trip latency) or a single unbounded
 * `Promise.all` (opens as many concurrent transactions as there are rows in
 * a page, which can exhaust the connection pool). Found by independent
 * review of the original fully-serial version.
 */
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function backfillOrgMembership() {
  const dryRun = process.argv.includes('--dry-run');

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let scanned = 0;
  let cursor: string | undefined;

  // Paginated instead of one unbounded findMany: on a large accounts table,
  // loading every row into memory before processing a single one is a
  // multi-minute/OOM-risk operation with nothing to show for it until the
  // very end. This scans PAGE_SIZE accounts at a time in id order. Found by
  // independent review.
  for (;;) {
    // Soft-deleted accounts must never get a real Organization/OrgMember
    // row: the backfill's own idempotency check (skip if orgMembership
    // exists) means a deleted account processed once is never revisited,
    // so this would otherwise be a one-way, unrecoverable pollution of the
    // org tables for accounts that can't even log in to use them.
    const accounts = await prisma.account.findMany({
      where: { isDeleted: false },
      include: {
        organizationProfile: true,
        orgMembership: true,
      },
      take: PAGE_SIZE,
      orderBy: { id: 'asc' },
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });

    if (accounts.length === 0) break;
    scanned += accounts.length;
    cursor = accounts[accounts.length - 1]!.id;

    await mapWithConcurrency(accounts, CONCURRENCY, async (account) => {
      if (account.orgMembership) {
        skipped += 1;
        return;
      }

      const orgName = account.organizationProfile?.organizationName || account.email;

      if (dryRun) {
        console.log(
          `[backfill-org-membership] (dry-run) would create Organization "${orgName}" anchored to account ${account.id}`,
        );
        processed += 1;
        return;
      }

      try {
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
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          // A concurrent signup (or a second concurrent backfill run) beat
          // this account to it — it now has an OrgMember row that the
          // initial snapshot didn't know about. Not a failure, just stale
          // information; count it as already-migrated.
          skipped += 1;
        } else {
          failed += 1;
          console.error(`[backfill-org-membership] failed for account ${account.id}:`, err);
        }
      }
    });

    if (accounts.length < PAGE_SIZE) break;
  }

  console.log(
    `[backfill-org-membership]${dryRun ? ' (dry-run)' : ''} done. accounts processed: ${processed}, accounts skipped (already migrated): ${skipped}, accounts failed: ${failed}, total accounts: ${scanned}`,
  );

  if (failed > 0) {
    process.exitCode = 1;
  }
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
